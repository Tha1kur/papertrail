import { ApiError } from "./client";
import type { ApiErrorBody, Citation } from "./types";

export type ChatStreamEvent =
  | { type: "message"; messageId: string; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done"; messageId: string; provider: string; model: string }
  | { type: "error"; message: string; messageId: string };

export interface StreamRequest {
  threadId: string;
  message: string;
  clientMessageId: string;
  signal: AbortSignal;
}

/**
 * Streams a reply over SSE.
 *
 * Note this uses fetch rather than EventSource. EventSource is the obvious
 * tool and cannot be used here for two reasons: it only issues GET requests,
 * so the message would have to travel in the URL — where it would land in
 * access logs — and it cannot be cancelled in a way that aborts the
 * underlying request. Reading the body stream manually gives both a POST
 * body and a working AbortSignal.
 */
export async function* streamChat(
  request: StreamRequest,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: request.threadId,
      message: request.message,
      clientMessageId: request.clientMessageId,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    let code = "UNKNOWN";
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    const retryAfter = response.headers.get("retry-after");
    throw new ApiError(
      response.status,
      code,
      message,
      undefined,
      retryAfter ? Number(retryAfter) : undefined,
    );
  }

  if (!response.body) throw new Error("Response had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Buffer until a complete event is present. A chunk boundary has no
      // relationship to an event boundary, so splitting on every read would
      // intermittently try to parse half a JSON object — a bug that only
      // appears under load and is miserable to reproduce.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");

        if (data.length > 0) {
          try {
            yield JSON.parse(data) as ChatStreamEvent;
          } catch {
            // A malformed frame should not kill an otherwise good stream.
          }
        }

        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Releases the connection when the consumer stops early — otherwise the
    // socket stays open until the browser eventually reclaims it.
    reader.releaseLock();
  }
}
