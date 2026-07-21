import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { httpLogger } from "./middleware/httpLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { ForbiddenError } from "./lib/errors.js";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import threadRoutes from "./routes/threads.js";
import authRoutes from "./routes/auth.js";
import documentRoutes from "./routes/documents.js";

/**
 * Builds the Express app without starting a listener.
 *
 * Keeping construction separate from `listen()` is what makes the API
 * testable: Supertest can drive this object directly, in-process, with no
 * port binding and no cleanup.
 */
export function buildApp(): Express {
  const app = express();

  // Render/Vercel terminate TLS upstream, so the client IP arrives in
  // X-Forwarded-For. Without this, rate limiting would see the proxy's IP
  // for every user and throttle everyone as if they were one person.
  app.set("trust proxy", 1);

  // Removes the `X-Powered-By: Express` banner among other headers.
  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin, curl, or a server-to-server call.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        callback(new ForbiddenError(`Origin ${origin} is not allowed`));
      },
      // Required for the httpOnly auth cookies added in the auth phase.
      // Note this is why the origin list can never be "*" — browsers reject
      // a wildcard origin on credentialed requests.
      credentials: true,
      exposedHeaders: ["x-request-id"],
    }),
  );

  // The default body limit is 100kb. Stated explicitly because it is a
  // security control, not a formatting preference: it is the thing standing
  // between us and a memory-exhaustion request.
  app.use(express.json({ limit: "1mb" }));

  // Auth tokens arrive as httpOnly cookies, so they must be parsed before
  // any route that reads them.
  app.use(cookieParser());

  app.use(httpLogger);

  app.use("/health", healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/threads", threadRoutes);
  app.use("/api/chat", chatRoutes);

  // Order is load-bearing: 404 must come after all routes, and the error
  // handler must be last or Express will not recognise it as one.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
