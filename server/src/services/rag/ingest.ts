import { createHash } from "node:crypto";
import DocumentModel, { type DocumentDoc } from "../../models/Document.js";
import ChunkModel from "../../models/Chunk.js";
import { embeddingProvider } from "../llm/index.js";
import { logger } from "../../lib/logger.js";
import { ConflictError } from "../../lib/errors.js";
import { extract } from "./extract.js";
import { chunkPages } from "./chunk.js";

/**
 * Embedding requests are batched. One call per chunk would mean hundreds of
 * round trips for a modest PDF and would exhaust a free-tier rate limit
 * almost immediately.
 */
const EMBED_BATCH_SIZE = 50;

export interface IngestInput {
  userId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Registers an upload and returns immediately with the document in
 * `pending`.
 *
 * Processing is kicked off separately rather than awaited, because
 * extraction plus embedding takes tens of seconds for a large file — long
 * enough that an HTTP request holding it open would hit every proxy timeout
 * between the client and us. The client polls status instead.
 */
export async function registerUpload(input: IngestInput): Promise<DocumentDoc> {
  const contentHash = hashContent(input.buffer);

  try {
    return await DocumentModel.create({
      userId: input.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.buffer.byteLength,
      contentHash,
      status: "pending",
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new ConflictError("You have already uploaded that file");
    }
    throw err;
  }
}

/**
 * Extract, chunk, embed, store.
 *
 * Deliberately not wrapped in a transaction. Embedding a large document
 * takes far longer than MongoDB's 60-second transaction limit, and holding
 * one open that long would block the oplog. Instead the document's status
 * is the consistency mechanism: chunks are only reachable once status flips
 * to `ready`, and a failure deletes whatever was written before marking the
 * document failed.
 */
export async function processDocument(documentId: string, userId: string): Promise<void> {
  const document = await DocumentModel.findOne({ _id: documentId, userId });
  if (!document) return;

  const started = Date.now();

  try {
    document.status = "processing";
    await document.save();

    // Re-reading the buffer is avoided by passing it through; see the route.
    const buffer = pendingBuffers.get(documentId);
    if (!buffer) throw new Error("Upload buffer missing — server may have restarted");

    const extraction = await extract(buffer, document.mimeType);
    const chunks = chunkPages(extraction.pages);

    if (chunks.length === 0) {
      throw new Error("Document produced no usable text");
    }

    let stored = 0;

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);

      const embedded = await embeddingProvider.embed({
        texts: batch.map((c) => c.content),
        // Stored passages, not a search query — the task type changes the
        // vector, and mismatching it here degrades every future search.
        purpose: "document",
      });

      await ChunkModel.insertMany(
        batch.map((chunk, offset) => ({
          documentId: document._id,
          userId,
          index: chunk.index,
          content: chunk.content,
          embedding: embedded.vectors[offset],
          page: chunk.page,
          tokens: chunk.tokens,
        })),
      );

      stored += batch.length;
    }

    document.status = "ready";
    document.chunkCount = stored;
    document.characters = extraction.characters;
    await document.save();

    logger.info(
      { documentId, chunks: stored, characters: extraction.characters, ms: Date.now() - started },
      "document indexed",
    );
  } catch (err) {
    // Partial chunks are worse than none: retrieval would return a fragment
    // of the document and present it as the whole picture.
    await ChunkModel.deleteMany({ documentId });

    document.status = "failed";
    document.chunkCount = 0;
    document.error = toUserMessage(err);
    await document.save();

    logger.error({ err, documentId }, "document ingestion failed");
  } finally {
    pendingBuffers.delete(documentId);
  }
}

/**
 * Uploaded bytes held in memory between the request returning and the
 * background job reading them.
 *
 * This is the honest limitation of a single-instance free tier: a restart
 * mid-processing loses the buffer and the document is marked failed rather
 * than silently sitting in `pending` forever. The scalable answer is object
 * storage plus a real queue, which is not free and not warranted yet.
 */
const pendingBuffers = new Map<string, Buffer>();

export function holdBuffer(documentId: string, buffer: Buffer): void {
  pendingBuffers.set(documentId, buffer);
}

export async function deleteDocument(documentId: string, userId: string): Promise<boolean> {
  const document = await DocumentModel.findOneAndDelete({ _id: documentId, userId });
  if (!document) return false;

  // Chunks are removed after the document, so a crash between the two leaves
  // orphans that no query can reach rather than a document whose content has
  // silently vanished.
  await ChunkModel.deleteMany({ documentId, userId });
  return true;
}

function toUserMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return "Processing failed";
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}
