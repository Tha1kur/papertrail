import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../lib/logger.js";

/**
 * Connect before the HTTP server starts accepting traffic.
 *
 * The order matters: if we listen first and connect after, there is a window
 * where the service answers requests it cannot possibly serve, and every one
 * of them 500s. Better to stay down until we can actually do the job.
 */
export async function connectDatabase(): Promise<void> {
  // Reject writes against fields absent from the schema instead of silently
  // dropping them — a silent drop is a data-loss bug that surfaces weeks later.
  mongoose.set("strictQuery", true);

  mongoose.connection.on("error", (err) => {
    logger.error({ err }, "mongodb connection error");
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("mongodb disconnected — driver will retry");
  });

  mongoose.connection.on("reconnected", () => {
    logger.info("mongodb reconnected");
  });

  await mongoose.connect(env.MONGODB_URI, {
    // Fail fast on a bad URI rather than hanging for the 30s default.
    serverSelectionTimeoutMS: 8_000,
    // Atlas M0 caps concurrent connections; staying well under avoids
    // the driver being refused during a redeploy overlap.
    maxPoolSize: 10,
    minPoolSize: 1,
  });

  logger.info(
    { database: mongoose.connection.name },
    "connected to mongodb",
  );
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close(false);
  logger.info("mongodb connection closed");
}

/** 1 = connected. Used by the readiness probe. */
export function isDatabaseHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}
