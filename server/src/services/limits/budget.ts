import UsageDailyModel from "../../models/UsageDaily.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { RateLimitError } from "../../lib/errors.js";

/** UTC day key, so the reset moment is the same everywhere and unambiguous. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface UsageSnapshot {
  day: string;
  totalTokens: number;
  budget: number;
  remaining: number;
  requests: number;
}

export async function getUsage(userId: string): Promise<UsageSnapshot> {
  const day = today();
  const row = await UsageDailyModel.findOne({ userId, day }).lean();

  const totalTokens = (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0) + (row?.embedTokens ?? 0);

  return {
    day,
    totalTokens,
    budget: env.DAILY_TOKEN_BUDGET,
    remaining: Math.max(0, env.DAILY_TOKEN_BUDGET - totalTokens),
    requests: row?.requests ?? 0,
  };
}

/**
 * Refuses the request if the user has already spent their daily budget.
 *
 * Checked before the call rather than after, because after is too late —
 * the tokens are spent and the bill exists regardless of what we do with
 * the response.
 *
 * Note this permits a single request to overshoot: we cannot know a
 * response's size until it is generated, so someone at 99% of budget can
 * still start one more turn. Bounding that properly would mean capping
 * max output tokens against the remaining budget, which is a refinement
 * worth making; overshooting by one response is an acceptable error, and
 * far better than the alternative of only noticing after the quota is gone.
 */
export async function assertWithinBudget(userId: string): Promise<UsageSnapshot> {
  const usage = await getUsage(userId);

  if (usage.totalTokens >= usage.budget) {
    logger.warn({ userId, spent: usage.totalTokens, budget: usage.budget }, "daily budget exhausted");

    // Seconds until UTC midnight, so the client is told when it can retry
    // rather than being left to guess.
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    const retryAfter = Math.ceil((midnight.getTime() - Date.now()) / 1000);

    throw new RateLimitError(
      "You have reached your daily usage limit. It resets at midnight UTC.",
      retryAfter,
    );
  }

  return usage;
}

/**
 * Records spend after a call.
 *
 * `upsert` with `$inc` rather than read-modify-write: two concurrent
 * requests doing the latter would both read the same starting value and one
 * increment would be lost. $inc is applied by the database atomically.
 */
export async function recordUsage(
  userId: string,
  usage: { inputTokens?: number; outputTokens?: number; embedTokens?: number },
): Promise<void> {
  const increment = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    embedTokens: usage.embedTokens ?? 0,
    requests: 1,
  };

  try {
    await UsageDailyModel.updateOne(
      { userId, day: today() },
      { $inc: increment },
      { upsert: true },
    );
  } catch (err) {
    // Accounting must never fail the user's request. The answer has already
    // been generated and paid for; losing the record of it is a reporting
    // problem, not a reason to throw away work the user is waiting for.
    logger.error({ err, userId }, "failed to record usage");
  }
}
