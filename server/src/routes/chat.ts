import { Router } from "express";
import { z } from "zod";
import ThreadModel from "../models/Thread.js";
import { getOpenAIAPIResponse } from "../lib/openai.js";
import { validate } from "../middleware/validate.js";
import { NotFoundError, UpstreamError } from "../lib/errors.js";

const router = Router();

const ThreadIdParams = z.object({
  threadId: z.string().trim().min(1).max(64),
});

const ChatBody = z.object({
  threadId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1, "Message cannot be empty").max(8_000),
});

/**
 * List threads, newest first.
 *
 * `messages` is deliberately excluded — the sidebar only needs titles, and
 * shipping every message of every thread to render a list is the kind of
 * over-fetch that is invisible in development and fatal in production.
 */
router.get("/thread", async (_req, res) => {
  const threads = await ThreadModel.find({}, { messages: 0 })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  res.json(threads);
});

router.get("/thread/:threadId", validate({ params: ThreadIdParams }), async (req, res) => {
  const { threadId } = req.params;

  const thread = await ThreadModel.findOne({ threadId }, { messages: 1 }).lean();

  // The original wrote a 404 and then carried on to read `thread.messages`
  // off null, so a missing thread produced a crash *after* the response had
  // already been sent. Throwing instead of writing-and-continuing makes that
  // class of mistake impossible.
  if (!thread) throw new NotFoundError("Thread");

  res.json(thread.messages);
});

router.delete("/thread/:threadId", validate({ params: ThreadIdParams }), async (req, res) => {
  const { threadId } = req.params;

  const deleted = await ThreadModel.findOneAndDelete({ threadId });
  if (!deleted) throw new NotFoundError("Thread");

  res.status(204).end();
});

router.post("/chat", validate({ body: ChatBody }), async (req, res) => {
  const { threadId, message } = req.body as z.infer<typeof ChatBody>;

  let thread = await ThreadModel.findOne({ threadId });

  if (!thread) {
    thread = new ThreadModel({
      threadId,
      // Titling the thread with the entire first message means a 8,000
      // character paste becomes the sidebar label. Truncate at a word
      // boundary instead.
      title: buildTitle(message),
      messages: [],
    });
  }

  thread.messages.push({ role: "user", content: message });

  let reply: string;
  try {
    reply = await getOpenAIAPIResponse(message);
  } catch (err) {
    // Persist the user's message even though the reply failed — losing what
    // someone typed because a third party had a bad minute is unacceptable.
    await thread.save();
    throw new UpstreamError("Language model", "The model could not be reached", err);
  }

  thread.messages.push({ role: "assistant", content: reply });
  await thread.save();

  res.json({ reply });
});

function buildTitle(message: string, maxLength = 60): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;

  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export default router;
