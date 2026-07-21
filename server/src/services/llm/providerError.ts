/**
 * A provider call failed. `retryable` is the field the failover logic reads.
 *
 * The distinction is important and easy to get wrong. Failing over on a 401
 * means a typo'd API key silently burns the fallback's quota too, and the
 * logs blame the wrong service. Failing over on a 400 means a malformed
 * request gets sent twice and rejected twice. Only transient conditions —
 * rate limits, upstream 5xx, timeouts, dropped connections — are worth
 * retrying somewhere else.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
    Error.captureStackTrace(this, ProviderError);
  }
}

/** Whether an HTTP status from a provider is worth retrying elsewhere. */
export function isRetryableStatus(status: number): boolean {
  // 408 request timeout, 409 conflict/overloaded, 425 too early,
  // 429 rate limited, and anything 5xx.
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Network-level failures arrive as TypeError from fetch, or as DOMException
 * on abort. A user-initiated abort must NOT be treated as retryable — the
 * user closed the tab; retrying against a second provider would be spending
 * their quota to produce a response that is thrown away.
 */
export function classifyThrown(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const isAbort =
    err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

  if (isAbort) {
    // A timeout is ours to retry; a caller-initiated cancel is not.
    const isTimeout = err.name === "TimeoutError";
    return new ProviderError(
      provider,
      isTimeout ? "Request timed out" : "Request cancelled",
      isTimeout,
      undefined,
      err,
    );
  }

  return new ProviderError(
    provider,
    err instanceof Error ? err.message : "Network failure",
    true,
    undefined,
    err,
  );
}
