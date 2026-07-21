import pino from "pino";
import { env, isProduction } from "../config/env.js";

/**
 * Structured JSON logs in production so they can be queried; human-readable
 * pretty output in development so they can be read.
 *
 * `redact` is not optional here — this service handles auth cookies and API
 * keys, and a log line is the easiest way to leak one.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.token",
      "*.apiKey",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});

export type Logger = typeof logger;
