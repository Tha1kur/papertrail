import mongoose from "mongoose";
import ChunkModel from "../../models/Chunk.js";
import { embeddingProvider } from "../llm/index.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";

export const VECTOR_INDEX_NAME = "chunk_vector_index";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  content: string;
  score: number;
  tokens: number;
}

export interface RetrieveOptions {
  userId: string;
  query: string;
  limit?: number;
  signal?: AbortSignal | undefined;
}

/**
 * Finds the passages most similar to a question.
 *
 * `numCandidates` is the knob people miss. Atlas's vector search is
 * approximate: it explores numCandidates nodes and returns the best `limit`
 * from those. Setting it equal to limit makes the search fast and bad —
 * quality comes from searching a wider pool than you return. Roughly 10-20x
 * is the usual guidance.
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievedChunk[]> {
  const limit = options.limit ?? env.RAG_TOP_K;
  const query = options.query.trim();
  if (query.length === 0) return [];

  const embedded = await embeddingProvider.embed({
    texts: [query],
    // Asymmetric on purpose: the same text embedded as a query and as a
    // document produces different vectors, and the models are trained so
    // that a RETRIEVAL_QUERY vector lands near the RETRIEVAL_DOCUMENT
    // vectors that answer it. Using the wrong one here is a silent
    // quality regression that still returns plausible-looking results.
    purpose: "query",
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const queryVector = embedded.vectors[0];
  if (!queryVector) return [];

  try {
    const results = await ChunkModel.aggregate<RetrievedChunk>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: "embedding",
          queryVector,
          numCandidates: Math.max(limit * 15, 100),
          limit,
          /**
           * Tenant isolation inside the vector index itself.
           *
           * This has to be a pre-filter, not a post-filter. Retrieving the
           * global top-k and then discarding other users' chunks would leak
           * through timing and result counts, and would also starve the
           * user's own results — their best match might be rank 200
           * globally and never surveyed at all.
           */
          filter: { userId: { $eq: new mongoose.Types.ObjectId(options.userId) } },
        },
      },
      {
        $lookup: {
          from: "documents",
          localField: "documentId",
          foreignField: "_id",
          as: "document",
          pipeline: [{ $project: { filename: 1 } }],
        },
      },
      { $unwind: "$document" },
      {
        $project: {
          _id: 0,
          chunkId: { $toString: "$_id" },
          documentId: { $toString: "$documentId" },
          filename: "$document.filename",
          page: { $ifNull: ["$page", null] },
          content: 1,
          tokens: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]);

    return results;
  } catch (err) {
    /**
     * The vector index is created through the Atlas UI or Admin API, not by
     * the driver, so it can genuinely be missing on a fresh deployment.
     *
     * Degrading to zero results rather than throwing is deliberate: chat
     * still works, it just answers without documents. Failing the whole
     * request would turn a setup step nobody has done yet into a total
     * outage.
     */
    logger.error(
      { err, index: VECTOR_INDEX_NAME },
      "vector search failed — is the Atlas index created? continuing without retrieval",
    );
    return [];
  }
}

/**
 * Trims retrieved passages to a token budget and formats them for the
 * prompt.
 *
 * Numbered because the model is asked to cite by number: free-form citation
 * produces invented filenames and page numbers, whereas "[3]" is checkable
 * against a list we control.
 */
export function formatContext(
  chunks: RetrievedChunk[],
  budgetTokens: number,
): { text: string; used: RetrievedChunk[] } {
  const used: RetrievedChunk[] = [];
  let spent = 0;

  for (const chunk of chunks) {
    // +20 for the source header we wrap each passage in.
    const cost = chunk.tokens + 20;
    if (spent + cost > budgetTokens) break;

    used.push(chunk);
    spent += cost;
  }

  if (used.length === 0) return { text: "", used };

  const text = used
    .map((chunk, i) => {
      const location = chunk.page !== null ? `${chunk.filename}, page ${chunk.page}` : chunk.filename;
      return `[${i + 1}] ${location}\n${chunk.content}`;
    })
    .join("\n\n---\n\n");

  return { text, used };
}
