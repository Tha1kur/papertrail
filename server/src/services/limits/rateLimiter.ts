/**
 * Rate limiting, behind an interface so the storage can change without the
 * middleware changing.
 *
 * Two implementations: Redis for real deployments, in-memory for local
 * development and tests. The distinction is not cosmetic — an in-memory
 * limiter is per-process, so with two instances behind a load balancer a
 * caller gets twice the allowance. It is correct only when there is exactly
 * one process, which is true on a free tier and false the moment it is not.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** When the window resets, for the Retry-After and X-RateLimit headers. */
  resetAt: Date;
  limit: number;
}

export interface RateLimiter {
  readonly name: string;
  /**
   * Records an attempt against `key` and reports whether it is permitted.
   *
   * Consumes on every call, including denied ones. That is deliberate: a
   * caller hammering the endpoint should not get a fresh allowance simply
   * because their previous requests were rejected.
   */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

/**
 * Sliding window log.
 *
 * A fixed window is simpler but lets a caller send `limit` requests at
 * 11:59:59 and `limit` again at 12:00:00 — double the intended rate,
 * precisely at the boundary, which is exactly when a retry storm arrives.
 * A sliding window looks back over the trailing window from *now*, so the
 * rate holds no matter where the request lands.
 *
 * The cost is storing one timestamp per request rather than one counter,
 * which is bounded by `limit` and therefore small.
 */
export function buildResult(
  timestamps: number[],
  limit: number,
  windowMs: number,
  now: number,
): RateLimitResult {
  const allowed = timestamps.length <= limit;
  const oldest = timestamps[0] ?? now;

  return {
    allowed,
    remaining: Math.max(0, limit - timestamps.length),
    // The window frees up when the oldest request in it ages out.
    resetAt: new Date(oldest + windowMs),
    limit,
  };
}
