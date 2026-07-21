import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError, NotFoundError, RateLimitError, ValidationError } from "../lib/errors.js";
import { isProduction } from "../config/env.js";

/** Shape every error response on this API takes. The frontend depends on it. */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/** Terminal 404 for unmatched routes, so they flow through the same handler. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * Translates anything thrown anywhere in the app into a consistent response.
 *
 * Express 5 forwards rejected promises from async handlers here automatically,
 * which is why there is no `express-async-errors` and no try/catch in the
 * controllers.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const normalised = normalise(err);
  const requestId = typeof req.id === "string" ? req.id : undefined;

  // A bug gets a stack trace at error level; an expected failure does not.
  if (normalised.isOperational) {
    req.log?.warn({ code: normalised.code, err: normalised.message }, "request failed");
  } else {
    req.log?.error({ err }, "unhandled error");
  }

  // Checked against the original error, not `normalised` — that is a plain
  // object built by normalise() and can never be an instanceof anything.
  // Getting this wrong meant the header was silently never set, and a
  // client had no idea how long to wait before retrying.
  if (err instanceof RateLimitError && err.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
  }

  // Headers already sent means a response was streaming when it failed.
  // We cannot send JSON now; just kill the connection and let the client retry.
  if (res.headersSent) {
    res.end();
    return;
  }

  const body: ErrorBody = {
    error: {
      code: normalised.code,
      // Never surface a programmer error's message — it may contain internals.
      message: normalised.isOperational ? normalised.message : "Something went wrong",
      ...(requestId ? { requestId } : {}),
      ...(normalised.details !== undefined ? { details: normalised.details } : {}),
    },
  };

  // Stacks in development only. In production this is the leak.
  if (!isProduction && !normalised.isOperational && err instanceof Error && err.stack) {
    (body.error as ErrorBody["error"] & { stack?: string }).stack = err.stack;
  }

  res.status(normalised.statusCode).json(body);
};

interface Normalised {
  statusCode: number;
  code: string;
  message: string;
  isOperational: boolean;
  details?: unknown;
}

function normalise(err: unknown): Normalised {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      isOperational: err.isOperational,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }

  // Request body failed schema validation.
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    const wrapped = new ValidationError("Request validation failed", details);
    return {
      statusCode: wrapped.statusCode,
      code: wrapped.code,
      message: wrapped.message,
      isOperational: true,
      details,
    };
  }

  // Someone passed a malformed ObjectId — a client mistake, not a server bug.
  if (err instanceof mongoose.Error.CastError) {
    return {
      statusCode: 400,
      code: "INVALID_ID",
      message: `Invalid value for '${err.path}'`,
      isOperational: true,
    };
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 422,
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      isOperational: true,
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    };
  }

  // Duplicate key on a unique index.
  if (isDuplicateKeyError(err)) {
    return {
      statusCode: 409,
      code: "CONFLICT",
      message: "That value is already taken",
      isOperational: true,
    };
  }

  // express.json() rejecting a malformed body.
  if (err instanceof SyntaxError && "body" in err) {
    return {
      statusCode: 400,
      code: "MALFORMED_JSON",
      message: "Request body is not valid JSON",
      isOperational: true,
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : "Unknown error",
    isOperational: false,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}
