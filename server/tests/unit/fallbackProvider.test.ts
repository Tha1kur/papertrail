import { describe, expect, it } from "vitest";
import { FallbackProvider } from "../../src/services/llm/fallbackProvider.js";
import { FakeProvider } from "../../src/services/llm/fakeProvider.js";
import { ProviderError } from "../../src/services/llm/providerError.js";
import type { StreamEvent } from "../../src/services/llm/types.js";

const question = [{ role: "user" as const, content: "hello" }];

function failing(name: string, retryable: boolean, status?: number) {
  return new FakeProvider({
    name,
    failWith: new ProviderError(name, `simulated ${status ?? "error"}`, retryable, status),
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "delta") text += event.text;
  }
  return text;
}

describe("FallbackProvider.generate", () => {
  it("uses the primary when it succeeds", async () => {
    const primary = new FakeProvider({ name: "primary", replies: ["from primary"] });
    const secondary = new FakeProvider({ name: "secondary", replies: ["from secondary"] });

    const result = await new FallbackProvider([primary, secondary]).generate({
      messages: question,
    });

    expect(result.text).toBe("from primary");
    expect(secondary.calls).toHaveLength(0);
  });

  /**
   * The reason the whole abstraction exists: free tiers rate-limit without
   * warning, and a 429 should be a logged blip rather than a user-visible
   * failure.
   */
  it("fails over on a retryable error", async () => {
    const secondary = new FakeProvider({ name: "secondary", replies: ["rescued"] });

    const result = await new FallbackProvider([failing("primary", true, 429), secondary]).generate({
      messages: question,
    });

    expect(result.text).toBe("rescued");
    expect(result.provider).toBe("secondary");
  });

  /**
   * Failing over on a 401 would burn the fallback's quota because of a typo
   * in the primary's key, and the logs would blame the wrong service.
   */
  it("does NOT fail over on a non-retryable error", async () => {
    const secondary = new FakeProvider({ name: "secondary", replies: ["should not be used"] });

    await expect(
      new FallbackProvider([failing("primary", false, 401), secondary]).generate({
        messages: question,
      }),
    ).rejects.toThrow(ProviderError);

    expect(secondary.calls).toHaveLength(0);
  });

  it("throws the last error when every provider fails", async () => {
    await expect(
      new FallbackProvider([failing("a", true, 500), failing("b", true, 503)]).generate({
        messages: question,
      }),
    ).rejects.toThrow(/simulated 503/);
  });

  it("passes the same request to the fallback", async () => {
    const secondary = new FakeProvider({ name: "secondary" });

    await new FallbackProvider([failing("primary", true, 429), secondary]).generate({
      messages: question,
      system: "be terse",
      temperature: 0.3,
    });

    expect(secondary.calls[0]?.system).toBe("be terse");
    expect(secondary.calls[0]?.messages).toEqual(question);
  });

  it("stops trying once the caller has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const secondary = new FakeProvider({ name: "secondary" });

    await expect(
      new FallbackProvider([failing("primary", true, 429), secondary]).generate({
        messages: question,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // Spending the fallback's quota on a request nobody is waiting for.
    expect(secondary.calls).toHaveLength(0);
  });

  it("requires at least one provider", () => {
    expect(() => new FallbackProvider([])).toThrow();
  });
});

describe("FallbackProvider.stream", () => {
  it("fails over before the first token", async () => {
    const secondary = new FakeProvider({ name: "secondary", replies: ["rescued stream"] });

    const text = await collect(
      new FallbackProvider([failing("primary", true, 429), secondary]).stream({
        messages: question,
      }),
    );

    expect(text).toBe("rescued stream");
  });

  /**
   * The constraint that makes streaming failover different from the
   * non-streaming case: once a token has reached the caller we are
   * committed. Switching providers mid-stream would splice two different
   * answers together, and the user would read the first half of one followed
   * by the beginning of another.
   */
  it("does NOT fail over once output has been emitted", async () => {
    const mid = new FakeProvider({
      name: "mid",
      replies: ["alpha beta gamma delta epsilon"],
      failWith: new ProviderError("mid", "died mid-stream", true),
      failAfterDeltas: 2,
    });
    const secondary = new FakeProvider({ name: "secondary", replies: ["should not appear"] });

    let received = "";
    await expect(
      (async () => {
        for await (const event of new FallbackProvider([mid, secondary]).stream({
          messages: question,
        })) {
          if (event.type === "delta") received += event.text;
        }
      })(),
    ).rejects.toThrow(/died mid-stream/);

    expect(received.trim()).toBe("alpha beta");
    expect(secondary.calls).toHaveLength(0);
  });

  it("emits exactly one done event carrying usage", async () => {
    const events: StreamEvent[] = [];
    for await (const event of new FakeProvider({ replies: ["one two three"] }).stream({
      messages: question,
    })) {
      events.push(event);
    }

    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});
