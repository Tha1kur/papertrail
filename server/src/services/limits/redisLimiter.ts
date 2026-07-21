import { buildResult, type RateLimiter, type RateLimitResult } from "./rateLimiter.js";

/**
 * Sliding window backed by Upstash Redis over its REST API.
 *
 * REST rather than a TCP client because Upstash's free tier is HTTP-native
 * and this keeps the dependency to `fetch` — no connection pool to manage,
 * no socket to reconnect after a free-tier instance sleeps.
 *
 * The window is a sorted set keyed by timestamp: prune what has aged out,
 * add this request, count what remains. All four commands go in one
 * pipeline so the sequence is a single round trip — doing them separately
 * would let two concurrent requests interleave and both see a stale count.
 */
export class RedisRateLimiter implements RateLimiter {
  readonly name = "redis";

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1_000;
    const cutoff = now - windowMs;
    const redisKey = `ratelimit:${key}`;

    // A unique member per request: two requests in the same millisecond
    // would otherwise collide on score alone and one would be lost.
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

    const commands = [
      ["ZREMRANGEBYSCORE", redisKey, "0", String(cutoff)],
      ["ZADD", redisKey, String(now), member],
      ["ZRANGE", redisKey, "0", "-1", "WITHSCORES"],
      // Expiry is reset on every write so an idle key disappears on its own.
      // Without it, every key that ever existed is retained forever, and the
      // free tier is measured in commands and storage.
      ["EXPIRE", redisKey, String(windowSeconds + 60)],
    ];

    const response = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      // A limiter must never become the reason a request hangs.
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      throw new Error(`Upstash returned ${response.status}`);
    }

    const results = (await response.json()) as Array<{ result?: unknown; error?: string }>;
    const range = results[2]?.result;

    // ZRANGE WITHSCORES returns [member, score, member, score, ...].
    const timestamps: number[] = [];
    if (Array.isArray(range)) {
      for (let i = 1; i < range.length; i += 2) {
        const score = Number(range[i]);
        if (!Number.isNaN(score)) timestamps.push(score);
      }
    }

    timestamps.sort((a, b) => a - b);

    return buildResult(timestamps, limit, windowMs, now);
  }
}
