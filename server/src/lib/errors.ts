/**
 * A typed error hierarchy, so route handlers can `throw new NotFoundError()`
 * and one piece of middleware decides the status code, the log level, and
 * what the client is allowed to see.
 *
 * The distinction that matters is `isOperational`:
 *   - operational  = an expected failure (bad input, missing doc, rate limit).
 *                    Safe to show the user. Logged at warn.
 *   - programmer   = a bug (undefined deref, bad assumption).
 *                    Logged at error with a stack, shown to the user as a
 *                    generic 500 so we never leak internals.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  /** Stable, machine-readable identifier the frontend can branch on. */
  abstract readonly code: string;
  /** True for expected failures; false means we have a bug. */
  readonly isOperational: boolean = true;
  /** Extra context for the client — must never contain secrets. */
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = "BAD_REQUEST";
}

export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = "VALIDATION_FAILED";
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = "UNAUTHORIZED";

  constructor(message = "Authentication required") {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN";

  constructor(message = "You do not have access to this resource") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";

  constructor(resource = "Resource") {
    super(`${resource} not found`);
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "CONFLICT";
}

export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = "PAYLOAD_TOO_LARGE";
}

export class RateLimitError extends AppError {
  readonly statusCode = 429;
  readonly code = "RATE_LIMITED";

  constructor(
    message = "Too many requests",
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * A dependency we do not control failed (the LLM provider, the vector index).
 * Separated from a 500 because the cause is external, and because the client
 * may sensibly retry.
 */
export class UpstreamError extends AppError {
  readonly statusCode = 502;
  readonly code = "UPSTREAM_FAILURE";

  constructor(
    readonly service: string,
    message = `${service} is unavailable`,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
