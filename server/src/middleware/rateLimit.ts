import type { RequestHandler } from "express";
import { checkLimit } from "../services/limits/index.js";
import { RateLimitError } from "../lib/errors.js";

interface Options {
  /** Distinguishes one limit from another so chat and upload budgets do not
   *  share a counter. */
  bucket: string;
  limit: number;
  windowSeconds: number;
  /**
   * Key on the authenticated user where there is one, and fall back to IP
   * otherwise.
   *
   * IP alone is a poor key: users behind CGNAT or a university network
   * share one, so a per-IP limit throttles strangers together. It is still
   * the only option before login, which is why the auth endpoints use it.
   */
  by?: "user" | "ip";
}

export function rateLimit(options: Options): RequestHandler {
  const by = options.by ?? "user";

  return async (req, res, next) => {
    try {
      const identity = by === "user" && req.user ? `u:${req.user.id}` : `ip:${req.ip ?? "unknown"}`;
      const key = `${options.bucket}:${identity}`;

      const result = await checkLimit(key, options.limit, options.windowSeconds);

      // Standard headers so a client can back off intelligently rather than
      // retrying blindly into a wall.
      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.floor(result.resetAt.getTime() / 1000)));

      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));

        req.log?.warn({ bucket: options.bucket, identity }, "rate limit exceeded");

        throw new RateLimitError(
          `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
          retryAfter,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
