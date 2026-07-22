import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Guards the blank-value handling in config/env.ts.
 *
 * Hosting dashboards submit an untouched field as "" rather than omitting
 * it. Before this was handled, leaving Render's optional SENTRY_DSN box
 * empty produced "Invalid URL" and the service refused to start — a
 * fail-fast on a feature the operator had deliberately not enabled.
 *
 * The schema is reproduced here rather than importing env.ts, because that
 * module validates and calls process.exit at import time.
 */
function blankToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema,
  );
}

const OptionalUrl = blankToUndefined(z.string().url().optional());

const CorsOrigins = blankToUndefined(
  z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
);

describe("optional env vars", () => {
  it("accepts an unset value", () => {
    expect(OptionalUrl.safeParse(undefined).success).toBe(true);
  });

  it("accepts a blank value from a dashboard field", () => {
    const result = OptionalUrl.safeParse("");
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBeUndefined();
  });

  it("treats whitespace as blank", () => {
    expect(OptionalUrl.safeParse("   ").success).toBe(true);
  });

  it("still accepts a real value", () => {
    const result = OptionalUrl.safeParse("https://o1.ingest.sentry.io/123");
    expect(result.success && result.data).toBe("https://o1.ingest.sentry.io/123");
  });

  it("still rejects a malformed value", () => {
    // Blank means "not configured"; nonsense means someone made a mistake
    // and should be told immediately rather than at 3am.
    expect(OptionalUrl.safeParse("not-a-url").success).toBe(false);
  });
});

describe("CORS_ORIGINS", () => {
  it("falls back to the default when blank", () => {
    const result = CorsOrigins.safeParse("");
    // An empty allowlist silently rejects every browser request, and the
    // symptom is a CORS error against a server that looks perfectly healthy.
    expect(result.success && result.data).toEqual(["http://localhost:5173"]);
  });

  it("parses a comma-separated list", () => {
    const result = CorsOrigins.safeParse("https://a.vercel.app, https://b.dev");
    expect(result.success && result.data).toEqual(["https://a.vercel.app", "https://b.dev"]);
  });
});
