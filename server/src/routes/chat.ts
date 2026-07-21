import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { UpstreamError } from "../lib/errors.js";
import { SSEStream } from "../lib/sseResponse.js";
import { sendMessage, streamMessage } from "../services/chatService.js";

const router = Router();

const ChatBody = z.object({
  threadId: z.uuid("Thread id must be a UUID"),
  message: z.string().trim().min(1, "Message cannot be empty").max(8_000),
  /**
   * Optional, but the client should always send one. It is what makes a
   * retry safe: without it, a request that times out on the client but
   * succeeds on the server produces a duplicate message and a duplicate
   * model call when the client tries again.
   */
  clientMessageId: z.uuid().optional(),
});

type ChatInput = z.infer<typeof ChatBody>;

/**
 * Non-streaming send. Kept alongside the streaming endpoint because it is
 * far simpler to call from a script or a test, and the two share all their
 * logic in chatService.
 */
router.post("/", validate({ body: ChatBody }), async (req, res) => {
  const { threadId, message, clientMessageId } = req.body as ChatInput;

  try {
    const result = await sendMessage({
      threadId,
      message,
      ...(clientMessageId ? { clientMessageId } : {}),
    });

    req.log?.info({ threadId, provider: result.provider, model: result.model }, "reply generated");
    res.json({ reply: result.reply, messageId: result.messageId });
  } catch (err) {
    throw new UpstreamError("Language model", "The model could not be reached", err);
  }
});

/**
 * Streaming send over SSE.
 *
 * POST rather than the GET that EventSource requires, because the request
 * carries a body and EventSource cannot send one. Clients read this with
 * fetch and a ReadableStream instead.
 *
 * Note there is no try/catch translating errors into an HTTP status here:
 * once headers are sent the status is already committed, so failures are
 * delivered as an SSE `error` event on the open stream. The service layer
 * has already persisted whatever text arrived before the failure.
 */
router.post("/stream", validate({ body: ChatBody }), async (req, res) => {
  const { threadId, message, clientMessageId } = req.body as ChatInput;

  const stream = new SSEStream(req, res);

  // Closing the tab must actually stop generation. Without this the request
  // runs to completion against a socket nobody is reading, spending quota to
  // produce text that is discarded.
  const abort = new AbortController();
  stream.onClose(() => {
    abort.abort();
    req.log?.info({ threadId }, "client disconnected — generation aborted");
  });

  try {
    for await (const event of streamMessage({
      threadId,
      message,
      signal: abort.signal,
      ...(clientMessageId ? { clientMessageId } : {}),
    })) {
      if (stream.isClosed) break;
      stream.send(event);
    }
  } catch (err) {
    req.log?.error({ err, threadId }, "stream handler failed");
    stream.send({
      type: "error",
      message: "Generation failed",
    });
  } finally {
    stream.close();
  }
});

export default router;
