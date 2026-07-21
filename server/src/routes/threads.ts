import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { NotFoundError } from "../lib/errors.js";
import { decodeCursor } from "../lib/pagination.js";
import {
  deleteThread,
  findThread,
  listThreads,
  renameThread,
} from "../repositories/threadRepository.js";
import { listMessages } from "../repositories/messageRepository.js";

const router = Router();

/** Client-generated UUIDs. Validated so a caller cannot use the id field to
 *  smuggle operators into a query or bloat an index with arbitrary strings. */
const ThreadIdParams = z.object({
  threadId: z.uuid("Thread id must be a UUID"),
});

const PageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const RenameBody = z.object({
  title: z.string().trim().min(1, "Title cannot be empty").max(200),
});

type PageQueryInput = z.infer<typeof PageQuery>;

router.get("/", validate({ query: PageQuery }), async (req, res) => {
  const { cursor, limit } = req.validatedQuery as PageQueryInput;

  const page = await listThreads({
    ...(cursor ? { after: decodeCursor(cursor) } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  res.json(page);
});

router.get("/:threadId", validate({ params: ThreadIdParams }), async (req, res) => {
  const thread = await findThread(req.params.threadId as string);
  if (!thread) throw new NotFoundError("Thread");

  res.json(thread);
});

router.get(
  "/:threadId/messages",
  validate({ params: ThreadIdParams, query: PageQuery }),
  async (req, res) => {
    const threadId = req.params.threadId as string;
    const { cursor, limit } = req.validatedQuery as PageQueryInput;

    // 404 on a missing thread rather than returning an empty page, so the
    // client can tell "no messages yet" apart from "this does not exist".
    const thread = await findThread(threadId);
    if (!thread) throw new NotFoundError("Thread");

    const page = await listMessages(threadId, {
      ...(cursor ? { after: decodeCursor(cursor) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    res.json(page);
  },
);

router.patch(
  "/:threadId",
  validate({ params: ThreadIdParams, body: RenameBody }),
  async (req, res) => {
    const { title } = req.body as z.infer<typeof RenameBody>;

    const thread = await renameThread(req.params.threadId as string, title);
    if (!thread) throw new NotFoundError("Thread");

    res.json(thread);
  },
);

router.delete("/:threadId", validate({ params: ThreadIdParams }), async (req, res) => {
  const result = await deleteThread(req.params.threadId as string);
  if (!result.deleted) throw new NotFoundError("Thread");

  req.log?.info({ threadId: req.params.threadId, messages: result.messages }, "thread deleted");

  res.status(204).end();
});

export default router;
