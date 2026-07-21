import { env, isProduction, isTest } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { MemoryRateLimiter } from "./memoryLimiter.js";
import { RedisRateLimiter } from "./redisLimiter.js";
import type { RateLimiter, RateLimitResult } from "./rateLimiter.js";

function build(): RateLimiter {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    logger.info("rate limiter: redis (upstash)");
    return new RedisRateLimiter(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }

  if (isProduction) {
    // Not fatal — a running app with an imperfect limiter beats no app —
    // but this is a real gap and must not be discovered later by surprise.
    logger.warn(
      "rate limiter: IN-MEMORY in production. Limits are per-process, so multiple instances multiply every allowance. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  } else if (!isTest) {
    logger.info("rate limiter: in-memory (set UPSTASH_* for distributed limiting)");
  }

  return new MemoryRateLimiter();
}

const limiter = build();

/**
 * Applies a limit, failing open if the limiter itself is broken.
 *
 * Fail-open is the right call here specifically because it is not the only
 * defence. If Upstash is unreachable, refusing every request would convert
 * an outage in a non-critical dependency into a total outage of the product.
 * The daily token budget still holds — it lives in MongoDB, which the app
 * cannot serve a request without anyway, so the thing actually guarding the
 * API bill fails closed while the thing guarding request rate fails open.
 */
export async function checkLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    return await limiter.consume(key, limit, windowSeconds);
  } catch (err) {
    logger.error({ err, limiter: limiter.name }, "rate limiter unavailable — failing open");

    return {
      allowed: true,
      remaining: limit,
      resetAt: new Date(Date.now() + windowSeconds * 1_000),
      limit,
    };
  }
}

export type { RateLimiter, RateLimitResult } from "./rateLimiter.js";
export { MemoryRateLimiter } from "./memoryLimiter.js";
export { RedisRateLimiter } from "./redisLimiter.js";
