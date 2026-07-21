import type { RequestHandler } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/**
 * Validates and *replaces* the request parts with their parsed output, so
 * downstream handlers receive coerced, trimmed, known-shaped data instead of
 * `any` straight off the wire.
 *
 * Failures throw a ZodError, which the central error handler turns into a
 * 422 listing every invalid field at once — rather than making the client
 * discover its mistakes one request at a time.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
      // Express 5 makes req.query a getter, so it cannot be reassigned;
      // the parsed result is exposed separately instead.
      if (schemas.query) {
        Object.defineProperty(req, "validatedQuery", {
          value: schemas.query.parse(req.query),
          writable: false,
          configurable: true,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

declare global {
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
    }
  }
}
