import { buildResult, type RateLimiter, type RateLimitResult } from "./rateLimiter.js";

/**
 * Single-process sliding window.
 *
 * Correct only when there is exactly one instance. With two processes each
 * keeps its own log and a caller gets double the allowance — so this is a
 * development and test implementation, and the factory logs a warning when
 * it is selected outside those.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly name = "memory";

  private readonly windows = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    // Keys are unbounded — one per user per limit — so idle entries have to
    // be reclaimed or this is a slow memory leak that only shows up in
    // production, weeks in.
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // Must not hold the event loop open, or graceful shutdown hangs until
    // the timer fires.
    this.sweeper.unref();
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1_000;
    const cutoff = now - windowMs;

    const existing = this.windows.get(key) ?? [];
    // Drop anything that has aged out of the trailing window.
    const live = existing.filter((timestamp) => timestamp > cutoff);

    live.push(now);
    this.windows.set(key, live);

    return buildResult(live, limit, windowMs, now);
  }

  /** Drops keys whose entries have all expired. */
  private sweep(): void {
    const cutoff = Date.now() - 3_600_000;

    for (const [key, timestamps] of this.windows) {
      const live = timestamps.filter((timestamp) => timestamp > cutoff);
      if (live.length === 0) this.windows.delete(key);
      else this.windows.set(key, live);
    }
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
