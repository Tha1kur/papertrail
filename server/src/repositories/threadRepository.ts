import ThreadModel from "../models/Thread.js";
import { withTransaction } from "../lib/transaction.js";
import { deleteMessagesForThread } from "./messageRepository.js";
import {
  buildPage,
  clampLimit,
  cursorSort,
  pastCursor,
  type Cursor,
  type Page,
} from "../lib/pagination.js";

export interface ThreadView {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_PAGE_SIZE = 50;

/**
 * Threads for the sidebar, most recently active first.
 *
 * Ordered by lastMessageAt rather than updatedAt: renaming a thread should
 * not jump it to the top of the list, because the list means "where was I",
 * not "what did I touch".
 */
export async function listThreads(
  options: { after?: Cursor; limit?: number } = {},
): Promise<Page<ThreadView>> {
  const limit = clampLimit(options.limit, 30, MAX_PAGE_SIZE);

  const rows = await ThreadModel.find({
    ...(options.after ? pastCursor(options.after, "lastMessageAt", "desc") : {}),
  })
    .sort(cursorSort("lastMessageAt", "desc"))
    .limit(limit + 1)
    .lean();

  const page = buildPage(rows, limit, (row) => ({
    // Never null: ensureThread seeds it at creation precisely so this sort
    // key always exists. A null here would place the thread outside the
    // index's ordering and it would vanish from the sidebar.
    value: row.lastMessageAt ?? row.createdAt,
    id: String(row._id),
  }));

  return { ...page, items: page.items.map(toView) };
}

export async function findThread(id: string): Promise<ThreadView | null> {
  const row = await ThreadModel.findById(id).lean();
  return row ? toView(row) : null;
}

/**
 * Creates the thread if it does not exist, leaves it alone if it does.
 *
 * `upsert` rather than `create` is what makes the send path idempotent: the
 * client mints the thread id, so a retried first message must not produce a
 * second thread. `$setOnInsert` means a retry never overwrites a title the
 * user has since changed.
 */
export async function ensureThread(id: string, title: string): Promise<ThreadView> {
  const row = await ThreadModel.findOneAndUpdate(
    { _id: id },
    // lastMessageAt is seeded now rather than left null, so a thread with no
    // messages yet still sorts into the sidebar instead of disappearing.
    { $setOnInsert: { _id: id, title, messageCount: 0, lastMessageAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  // findOneAndUpdate with upsert+new always returns a document.
  return toView(row!);
}

export async function updateSummary(
  id: string,
  summary: string,
  summarisedThrough: Date,
): Promise<void> {
  await ThreadModel.updateOne({ _id: id }, { $set: { summary, summarisedThrough } });
}

/** Summary state is loaded separately from the list view, which does not
 *  need it — the sidebar would otherwise carry 4KB of prose per thread. */
export async function getSummaryState(
  id: string,
): Promise<{ summary: string; summarisedThrough: Date | null } | null> {
  const row = await ThreadModel.findById(id, { summary: 1, summarisedThrough: 1 }).lean();
  if (!row) return null;

  return {
    summary: row.summary ?? "",
    summarisedThrough: row.summarisedThrough ?? null,
  };
}

export async function renameThread(id: string, title: string): Promise<ThreadView | null> {
  const row = await ThreadModel.findOneAndUpdate(
    { _id: id },
    { $set: { title } },
    { new: true },
  ).lean();

  return row ? toView(row) : null;
}

/**
 * Deletes a thread and every message in it, atomically.
 *
 * Doing this as two independent writes risks orphaned messages: delete the
 * thread, crash, and the messages remain forever — invisible to the UI,
 * counting against a 512MB quota, with nothing left to link them to.
 */
export async function deleteThread(id: string): Promise<{ deleted: boolean; messages: number }> {
  return withTransaction(async (session) => {
    const thread = await ThreadModel.findOneAndDelete({ _id: id }, { session }).lean();
    if (!thread) return { deleted: false, messages: 0 };

    const messages = await deleteMessagesForThread(id, session);
    return { deleted: true, messages };
  });
}

interface RawThread {
  _id: unknown;
  title: string;
  messageCount: number;
  lastMessageAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toView(row: RawThread): ThreadView {
  return {
    id: String(row._id),
    title: row.title,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
