import { Router } from "express";
import { isDatabaseHealthy } from "../config/db.js";

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
  const healthy = database;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    checks: { database: database ? "up" : "down" },
  });
});

export default router;
