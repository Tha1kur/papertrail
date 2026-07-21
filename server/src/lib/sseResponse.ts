import type { Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Server side of an SSE connection.
 *
 * Three of these headers are load-bearing and easy to omit:
 *
 *   - `no-transform` stops intermediaries gzipping the stream. Compression
 *     buffers, and a buffered stream is not a stream — the client sees
 *     nothing for ten seconds and then the whole answer at once.
 *   - `X-Accel-Buffering: no` is the equivalent instruction to nginx, which
 *     sits in front of most managed hosts including the one we deploy to.
 *   - `flushHeaders()` sends them immediately instead of waiting for the
 *     first write, so the client can commit to the connection right away.
 */
export class SSEStream {
  private heartbeat: NodeJS.Timeout | undefined;
  /** The client went away. Nothing more should be written. */
  private clientGone = false;
  /** We finished and called res.end(). */
  private ended = false;

  constructor(
    private readonly req: Request,
    private readonly res: Response,
  ) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // An idle connection is indistinguishable from a dead one to a proxy,
    // and thinking hard before the first token is exactly when we look idle.
    // A comment line keeps the connection alive without the client seeing it.
    this.heartbeat = setInterval(() => {
      if (!this.clientGone && !this.ended) this.res.write(": ping\n\n");
    }, env.SSE_HEARTBEAT_MS);

    // unref so a live stream cannot hold the process open during shutdown.
    this.heartbeat.unref();
  }

  /**
   * Fires when the client actually disconnects.
   *
   * This listens on the *response*, not the request. On an IncomingMessage,
   * `close` fires when the request stream ends — which for a small JSON POST
   * is immediately after the body is parsed, long before the client has gone
   * anywhere. Listening there aborted every stream the instant it started.
   */
  onClose(handler: () => void): void {
    this.res.on("close", () => {
      // A normal end() also emits close. Only an early close is a disconnect.
      if (this.ended) return;
      this.clientGone = true;
      this.clearHeartbeat();
      handler();
    });
  }

  send(event: unknown): void {
    if (this.clientGone || this.ended) return;
    // JSON.stringify cannot emit a raw newline, so no payload can ever break
    // out of its own frame.
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Ends the response. Safe to call more than once. */
  close(): void {
    this.clearHeartbeat();
    if (this.ended) return;
    this.ended = true;
    // If the client has already gone, the socket is being torn down and
    // end() would be writing into a closed pipe.
    if (!this.clientGone) this.res.end();
  }

  /** True once the client has disconnected — the signal to stop generating. */
  get isClosed(): boolean {
    return this.clientGone;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
