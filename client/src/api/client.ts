import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True for failures that may succeed on a retry, so the UI can offer one
   *  rather than presenting a dead end. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status >= 500;
  }
}

/**
 * A single in-flight refresh, shared by every request that hits a 401.
 *
 * Without this, a page that fires five parallel requests on load — threads,
 * messages, documents, usage — would trigger five simultaneous refreshes on
 * an expired token. Since refresh tokens rotate, four of those would present
 * an already-rotated token, and the server would correctly read that as
 * theft and revoke the entire session family. The user gets logged out for
 * doing nothing but opening the app.
 *
 * So: the first 401 starts a refresh, everyone else awaits the same promise.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so concurrent callers all observe the same
      // settled promise before it is discarded.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

/** Notified when the session is definitively gone, so the app can redirect. */
type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};

export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Internal: prevents a refreshed request from recursing forever. */
  _retried?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, _retried, headers, ...rest } = options;

  const isFormData = body instanceof FormData;

  const response = await fetch(path, {
    ...rest,
    // Required for the httpOnly auth cookies to be sent at all.
    credentials: "include",
    headers: {
      // FormData must set its own Content-Type, including the multipart
      // boundary. Setting it manually produces a request the server cannot
      // parse, and the failure looks like a corrupt upload.
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined ? { body: isFormData ? body : JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !_retried && !path.includes("/auth/")) {
    const refreshed = await refreshSession();

    if (refreshed) {
      return apiRequest<T>(path, { ...options, _retried: true });
    }

    onSessionExpired();
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  // 204 has no body; parsing it would throw.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let message = `Request failed (${response.status})`;
  let requestId: string | undefined;

  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      requestId = body.error.requestId;
    }
  } catch {
    // Not JSON — a proxy error page, or the server died mid-response.
  }

  const retryAfter = response.headers.get("retry-after");

  return new ApiError(
    response.status,
    code,
    message,
    requestId,
    retryAfter ? Number(retryAfter) : undefined,
  );
}
