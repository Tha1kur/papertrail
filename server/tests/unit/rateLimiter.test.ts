import { afterEach, describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../../src/services/limits/memoryLimiter.js";

let limiter: MemoryRateLimiter;

afterEach(() => {
  limiter?.stop();
});

describe("MemoryRateLimiter", () => {
  it("admits exactly the limit and rejects the next", async () => {
    limiter = new MemoryRateLimiter();
    const key = "user-1";

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await limiter.consume(key, 3, 60));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it("reports remaining allowance", async () => {
    limiter = new MemoryRateLimiter();

    expect((await limiter.consume("k", 3, 60)).remaining).toBe(2);
    expect((await limiter.consume("k", 3, 60)).remaining).toBe(1);
    expect((await limiter.consume("k", 3, 60)).remaining).toBe(0);
  });

  /**
   * A caller hammering the endpoint must not earn a fresh allowance simply
   * because their previous requests were rejected.
   */
  it("counts denied attempts against the window", async () => {
    limiter = new MemoryRateLimiter();

    for (let i = 0; i < 10; i += 1) await limiter.consume("k", 2, 60);

    const result = await limiter.consume("k", 2, 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("keeps keys independent", async () => {
    limiter = new MemoryRateLimiter();

    await limiter.consume("alice", 1, 60);
    expect((await limiter.consume("alice", 1, 60)).allowed).toBe(false);
    expect((await limiter.consume("bob", 1, 60)).allowed).toBe(true);
  });

  /**
   * The reason for a sliding window rather than a fixed one: a fixed window
   * lets a caller spend the full allowance at the end of one window and
   * again at the start of the next, doubling the intended rate exactly at
   * the boundary — which is when a retry storm arrives.
   */
  it("slides rather than resetting on a boundary", async () => {
    limiter = new MemoryRateLimiter();

    await limiter.consume("k", 1, 1);
    expect((await limiter.consume("k", 1, 1)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await limiter.consume("k", 1, 1)).allowed).toBe(true);
  });

  it("reports when the window frees up", async () => {
    limiter = new MemoryRateLimiter();
    const before = Date.now();

    const result = await limiter.consume("k", 1, 60);

    expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(result.resetAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});
