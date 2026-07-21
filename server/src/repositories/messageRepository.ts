import type { ClientSession } from "mongoose";
import MessageModel, { type MessageRole, type MessageStatus } from "../models/Message.js";
import ThreadModel from "../models/Thread.js";
import { withTransaction } from "../lib/transaction.js";
import {
  buildPage,
  clampLimit,
  cursorSort,
  pastCursor,
  type Cursor,
  type Page,
} from "../lib/pagination.js";

export interface MessageView {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: Date;
  provider?: string;
  model?: string;
}

export interface AppendInput {
  threadId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  provider?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  clientMessageId?: string;
}

/** Highest page size we will honour, so a client cannot ask for everything. */
export const MAX_PAGE_SIZE = 100;

/**
 * Appends a message and updates the parent thread's counters atomically.
 *
 * If `clientMessageId` has been seen before on this thread, the existing
 * message is returned unchanged rather than a second one being created. That
 * is the idempotency guarantee: a user who taps send twice, or a client that
 * retries after a timeout, gets one message and one model call — not two of
 * each, and not two charges.
 */
export async function appendMessage(input: AppendInput): Promise<MessageView> {
  if (input.clientMessageId) {
    const existing = await MessageModel.findOne({
      threadId: input.threadId,
      clientMessageId: input.clientMessageId,
    }).lean();
    if (existing) return toView(existing);
  }

  try {
    return await withTransaction(async (session) => {
      const created = await MessageModel.create(
        [
          {
            threadId: input.threadId,
            role: input.role,
            content: input.content,
            status: input.status ?? "complete",
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.usage ? { usage: input.usage } : {}),
            ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
          },
        ],
        { session },
      );

      const message = created[0];
      if (!message) throw new Error("Message insert returned no document");

      await ThreadModel.updateOne(
        { _id: input.threadId },
        { $inc: { messageCount: 1 }, $set: { lastMessageAt: message.createdAt } },
        { session },
      );

      return toView(message.toObject());
    });
  } catch (err) {
    // Two concurrent requests carrying the same clientMessageId can both pass
    // the check above and race to insert. The unique index is what actually
    // enforces the guarantee; losing that race is a success, not an error.
    if (isDuplicateKey(err) && input.clientMessageId) {
      const existing = await MessageModel.findOne({
        threadId: input.threadId,
        clientMessageId: input.clientMessageId,
      }).lean();
      if (existing) return toView(existing);
    }
    throw err;
  }
}

/**
 * Creates the assistant's message up front, in `streaming` state, before any
 * tokens arrive.
 *
 * Writing only after the stream completes would mean a dropped connection
 * loses the entire partial answer. Writing a row first, then filling it in,
 * means whatever arrived is preserved and honestly labelled.
 */
export async function beginStreamingMessage(
  threadId: string,
  provider?: string,
  model?: string,
): Promise<string> {
  const view = await appendMessage({
    threadId,
    role: "assistant",
    content: "",
    status: "streaming",
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  return view.id;
}

export async function finaliseMessage(
  id: string,
  update: {
    content: string;
    status: MessageStatus;
    provider?: string;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
  },
): Promise<void> {
  await MessageModel.updateOne(
    { _id: id },
    {
      $set: {
        content: update.content,
        status: update.status,
        ...(update.provider ? { provider: update.provider } : {}),
        ...(update.model ? { model: update.model } : {}),
        ...(update.usage ? { usage: update.usage } : {}),
      },
    },
  );
}

/** One page of a conversation, oldest first. */
export async function listMessages(
  threadId: string,
  options: { after?: Cursor; limit?: number } = {},
): Promise<Page<MessageView>> {
  const limit = clampLimit(options.limit, 50, MAX_PAGE_SIZE);

  const rows = await MessageModel.find({
    threadId,
    ...(options.after ? pastCursor(options.after, "createdAt", "asc") : {}),
  })
    .sort(cursorSort("createdAt", "asc"))
    .limit(limit + 1)
    .lean();

  const page = buildPage(rows, limit, (row) => ({
    value: row.createdAt,
    id: String(row._id),
  }));

  return { ...page, items: page.items.map(toView) };
}

/**
 * The most recent N messages, returned oldest-first.
 *
 * Sorting descending and reversing is deliberate: the alternative — sorting
 * ascending and taking the last N — requires reading the entire conversation
 * to find its tail. This touches only N index entries regardless of how long
 * the thread is.
 */
export async function recentMessages(
  threadId: string,
  limit: number,
  since?: Date,
): Promise<MessageView[]> {
  const rows = await MessageModel.find({
    threadId,
    // `failed` messages are excluded: replaying a failed generation back to
    // the model teaches it that empty or broken replies are acceptable.
    status: { $ne: "failed" },
    // Anything at or before this instant is already captured in the thread's
    // summary; including it would pay for the same content twice.
    ...(since ? { createdAt: { $gt: since } } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  return rows.reverse().map(toView);
}

/** Removes every message in a thread. Session-aware so it can join the
 *  same transaction that deletes the thread itself. */
export async function deleteMessagesForThread(
  threadId: string,
  session?: ClientSession,
): Promise<number> {
  const result = await MessageModel.deleteMany(
    { threadId },
    session ? { session } : {},
  );
  return result.deletedCount ?? 0;
}

interface RawMessage {
  _id: unknown;
  threadId: string;
  role: string;
  content: string;
  status: string;
  createdAt: Date;
  provider?: string | null;
  model?: string | null;
}

function toView(row: RawMessage): MessageView {
  return {
    id: String(row._id),
    threadId: row.threadId,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    createdAt: row.createdAt,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
  };
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}
