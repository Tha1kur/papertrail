/**
 * Minimal Server-Sent Events parser for reading a streaming HTTP response.
 *
 * Both providers stream over SSE, so this lives here rather than being
 * written twice. It exists at all because the naive approach — decoding each
 * chunk and splitting on newlines — is wrong: TCP gives no guarantee that a
 * chunk boundary lines up with an event boundary. A single JSON payload can
 * and does arrive split across two chunks, which shows up as intermittent
 * parse failures under load and is miserable to debug after the fact.
 *
 * So we buffer until we actually see an event terminator.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. \r\n\r\n is in the spec too.
      let boundary = findBoundary(buffer);
      while (boundary !== null) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const data = extractData(rawEvent);
        if (data !== null) yield data;

        boundary = findBoundary(buffer);
      }
    }

    // Some servers close without a trailing blank line.
    const trailing = extractData(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    // Releasing the lock lets the underlying connection be torn down when the
    // consumer abandons the stream early — otherwise the socket leaks.
    reader.releaseLock();
  }
}

function findBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * Pulls the `data:` payload out of one event, joining multi-line data fields
 * with newlines as the spec requires. Comment lines (starting `:`) and other
 * fields are ignored.
 */
function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const parts: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    // Exactly one optional leading space is stripped, per spec.
    const value = line.slice(5);
    parts.push(value.startsWith(" ") ? value.slice(1) : value);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}
