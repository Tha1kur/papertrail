import { Router } from "express";
import { requireAuth, currentUser } from "../middleware/requireAuth.js";
import { getUsage } from "../services/limits/budget.js";

const router = Router();
router.use(requireAuth);

/**
 * The user's own spend for today.
 *
 * Exposed so the interface can warn someone approaching their limit rather
 * than letting them discover it mid-sentence as a 429. A quota that is only
 * visible at the moment it stops you is a bad quota.
 */
router.get("/", async (req, res) => {
  const usage = await getUsage(currentUser(req).id);

  res.json({
    day: usage.day,
    tokensUsed: usage.totalTokens,
    tokenBudget: usage.budget,
    tokensRemaining: usage.remaining,
    requests: usage.requests,
    percentUsed: Math.min(100, Math.round((usage.totalTokens / usage.budget) * 100)),
  });
});

export default router;
