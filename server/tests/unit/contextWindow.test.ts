import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/services/context/contextWindow.js";
import { estimateConversationTokens } from "../../src/services/context/tokens.js";
import type { ChatMessage } from "../../src/services/llm/types.js";

const SYSTEM = "You are a helpful assistant.";

function history(count: number, size = 40): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i} ${"x".repeat(size)}`,
  }));
}

describe("buildContext", () => {
  it("keeps everything when it fits in the budget", () => {
    const messages = history(4);
    const result = buildContext({ history: messages, systemPrompt: SYSTEM, budget: 10_000 });

    expect(result.messages).toHaveLength(4);
    expect(result.evicted).toHaveLength(0);
  });

  /**
   * The heart of the whole mechanism: when the budget bites, the *newest*
   * turns must survive. Evicting from the wrong end would drop the message
   * the user is actually referring to and keep small talk from an hour ago.
   */
  it("evicts oldest first and preserves the newest turns", () => {
    const messages = history(40);
    const result = buildContext({ history: messages, systemPrompt: SYSTEM, budget: 400 });

    expect(result.evicted.length).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));

    // Nothing is lost or duplicated in the split.
    expect(result.evicted.length + result.messages.length).toBe(messages.length);
    expect([...result.evicted, ...result.messages]).toEqual(messages);
  });

  it("stays within the token budget", () => {
    const budget = 500;
    const result = buildContext({ history: history(60), systemPrompt: SYSTEM, budget });

    expect(estimateConversationTokens(result.messages)).toBeLessThanOrEqual(budget);
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
  });

  it("charges the system prompt against the budget before history", () => {
    const huge = "s".repeat(4_000); // ~1000 tokens
    const result = buildContext({ history: history(20), systemPrompt: huge, budget: 1_100 });

    // Almost the entire budget went to the system prompt, so little history
    // can survive — but the result must still be under budget rather than
    // quietly overflowing.
    expect(result.estimatedTokens).toBeLessThanOrEqual(1_100);
  });

  it("folds the summary into the system prompt rather than the messages", () => {
    const result = buildContext({
      history: history(2),
      summary: "Earlier the user asked about deployment windows.",
      systemPrompt: SYSTEM,
      budget: 10_000,
    });

    expect(result.system).toContain("deployment windows");
    // A summary is context about the conversation, not a turn within it.
    expect(result.messages.every((m) => !m.content.includes("deployment windows"))).toBe(true);
  });

  it("handles an empty history", () => {
    const result = buildContext({ history: [], systemPrompt: SYSTEM, budget: 1_000 });

    expect(result.messages).toEqual([]);
    expect(result.evicted).toEqual([]);
  });

  /**
   * When the budget cannot fit even the system prompt, the newest message is
   * kept anyway and the budget is knowingly exceeded.
   *
   * This looks like a violation of the rule above, and it is a deliberate
   * one: sending zero messages means asking the model nothing, so the
   * request is guaranteed useless. Overshooting gives the provider's own
   * limit a chance to be the backstop, and truncating what the user typed is
   * a product decision rather than something to do silently here.
   */
  it("keeps the newest message even when the budget cannot fit it", () => {
    const result = buildContext({ history: history(10), systemPrompt: SYSTEM, budget: 1 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(history(10).at(-1));
    expect(result.evicted).toHaveLength(9);
  });

  it("never splits a message in half", () => {
    const messages = history(30);
    const result = buildContext({ history: messages, systemPrompt: SYSTEM, budget: 300 });

    // Every kept message must be byte-identical to an original.
    for (const message of result.messages) {
      expect(messages).toContainEqual(message);
    }
  });
});
