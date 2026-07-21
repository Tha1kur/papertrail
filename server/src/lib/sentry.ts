import * as Sentry from "@sentry/node";
import { env, isProduction } from "../config/env.js";
import { logger } from "./logger.js";
import { AppError } from "./errors.js";

/**
 * Error reporting, off unless a DSN is configured.
 *
 * Optional by design: the app must run for someone who has cloned it and
 * filled in nothing but a database URL. A hard dependency on an observability
 * vendor to boot is a barrier for no benefit.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    if (isProduction) {
      logger.warn("SENTRY_DSN not set — errors will only reach the logs");
    }
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),

    // Sampled, not exhaustive. The free tier is 5k events a month, and a
    // single bad deploy can produce that in minutes — at which point the
    // quota is gone and the *next* incident is invisible.
    tracesSampleRate: isProduction ? 0.1 : 0,

    /**
     * Operational errors are filtered out before sending.
     *
     * A 404, a validation failure, a rate limit — these are the system
     * working. Reporting them buries the actual bugs in noise and burns the
     * quota on events nobody will act on. Only programmer errors go to
     * Sentry; everything else is already in the structured logs.
     */
    beforeSend(event, hint) {
      const error = hint.originalException;
      if (error instanceof AppError && error.isOperational) return null;
      return event;
    },

    /**
     * Strip anything that could carry a credential or personal data.
     *
     * Sentry captures request context automatically, which is useful right
     * up until an auth cookie or an API key is copied into a third-party
     * service and retained there.
     */
    beforeSendTransaction(event) {
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    },

    // The default sends the user's IP and other identifiers. Errors are
    // debuggable from the request id without it.
    sendDefaultPii: false,
  });

  logger.info({ environment: env.NODE_ENV }, "sentry initialised");
}

/**
 * Reports a programmer error, attaching the request id so a Sentry event can
 * be lined up with the log lines for the same request.
 */
export function captureError(error: unknown, context: { requestId?: string; userId?: string }): void {
  if (!env.SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag("request_id", context.requestId);
    // Id only — never the email address.
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!env.SENTRY_DSN) return;

  // Events are batched, so a process that exits immediately after crashing
  // loses the very error that killed it.
  await Sentry.flush(timeoutMs).catch(() => {});
}
