import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { checkVectorIndex } from "./services/rag/indexHealth.js";
import { logger } from "./lib/logger.js";

/**
 * Process entry point: connect dependencies, start listening, and make sure
 * we shut down without dropping requests on the floor.
 */
async function main(): Promise<void> {
  await connectDatabase();

  // Reports loudly if retrieval is unavailable. Deliberately not fatal:
  // everything except document search still works without it.
  await checkVectorIndex();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
  });

  // Free-tier hosts idle connections aggressively; these must exceed the
  // platform's own timeout or we race it and clients see truncated responses.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  /**
   * A deploy sends SIGTERM. Without this handler the process dies instantly
   * and every in-flight request — including half-written SSE streams — is
   * severed. Here we stop accepting new connections, let existing ones
   * finish, then close the database.
   */
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutdown initiated");

    // If something hangs, we still have to exit — the platform will SIGKILL
    // us shortly anyway, and exiting cleanly gives better logs than being shot.
    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await disconnectDatabase();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection means we missed an `await` somewhere. The process
  // is now in an unknown state, so the honest move is to log loudly and
  // restart rather than limp on with corrupt assumptions.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "failed to start server");
  process.exit(1);
});
