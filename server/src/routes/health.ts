import { Router } from "express";
import { isDatabaseHealthy } from "../config/db.js";
import { isVectorIndexReady } from "../services/rag/indexHealth.js";

const router = Router();

/**
 * Liveness: is the process up? Always 200 if we can answer at all.
 * A failing liveness probe means "restart me".
 */
router.get("/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * Readiness: can we actually serve traffic? Checks dependencies.
 * A failing readiness probe means "stop sending me requests" — not "restart".
 *
 * Conflating the two is a classic outage amplifier: a blip in the database
 * restarts every instance simultaneously, and now nothing can recover.
 */
router.get("/", (_req, res) => {
  const database = isDatabaseHealthy();
  const vectorIndex = isVectorIndexReady();

  // Only the database gates readiness. A missing vector index degrades one
  // feature; refusing all traffic over it would be a worse outage than the
  // one it reports.
  const healthy = database;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? (vectorIndex ? "ok" : "degraded") : "unhealthy",
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      database: database ? "up" : "down",
      vectorIndex: vectorIndex ? "ready" : "unavailable",
    },
  });
});

export default router;
