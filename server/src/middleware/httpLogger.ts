import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { logger } from "../lib/logger.js";

/**
 * Attaches a request id to every request and exposes a child logger at
 * `req.log` that automatically carries it.
 *
 * The point of the id is correlation: when a user reports "it failed at
 * 4:32pm", they can give us the id from the error response and we can pull
 * every log line for that one request out of thousands.
 *
 * An inbound `x-request-id` is honoured so the id survives across hops if we
 * ever put a proxy or a second service in front of this one.
 */
export const httpLogger = pinoHttp({
  logger,

  genReqId: (req, res) => {
    const inbound = req.headers["x-request-id"];
    const id = typeof inbound === "string" && inbound.length > 0 ? inbound : randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },

  // Health checks would otherwise drown out real traffic.
  autoLogging: {
    ignore: (req) => req.url === "/health" || req.url === "/health/live",
  },

  customLogLevel: (_req, res, err) => {
    if (err) return "error";
    if (res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },

  // The defaults dump every header on every line. This keeps logs readable
  // and cheap, which matters on a free-tier log quota.
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
