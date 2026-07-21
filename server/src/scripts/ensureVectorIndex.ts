import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import ChunkModel from "../models/Chunk.js";
import { VECTOR_INDEX_NAME } from "../services/rag/retrieve.js";
import type { SearchIndexInfo } from "../types/atlasSearch.js";

/**
 * Creates the Atlas Vector Search index if it is missing.
 *
 * Search indexes are managed by Atlas rather than the database engine, so
 * they are not created by Mongoose's usual index syncing — they have to be
 * declared explicitly. Keeping that declaration here, in the repo, rather
 * than as a documented sequence of clicks in a web UI, means a fresh
 * deployment is reproducible and the definition is reviewable in a diff.
 *
 * Idempotent: safe to run on every deploy.
 */
async function main(): Promise<void> {
  await connectDatabase();

  const collection = ChunkModel.collection;

  // The collection must exist before an index can be built on it.
  const existing = await mongoose.connection.db
    ?.listCollections({ name: collection.collectionName })
    .toArray();

  if (!existing || existing.length === 0) {
    await mongoose.connection.db?.createCollection(collection.collectionName);
    logger.info({ collection: collection.collectionName }, "created collection");
  }

  const indexes = (await collection.listSearchIndexes().toArray()) as SearchIndexInfo[];
  const current = indexes.find((index) => index.name === VECTOR_INDEX_NAME);

  const definition = {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: env.GEMINI_EMBED_DIMENSIONS,
        /**
         * Cosine, and the provider normalises vectors to unit length before
         * storing them. On unit vectors cosine and dotProduct are
         * equivalent, but cosine is forgiving if a vector ever slips through
         * unnormalised — it would rank badly rather than nonsensically.
         */
        similarity: "cosine",
      },
      {
        /**
         * Declared so userId can be used as a pre-filter inside the search.
         * Without this field in the index definition, Atlas rejects the
         * filter and the only options left are searching every user's
         * chunks and discarding afterwards — which both leaks and starves
         * the user's own results.
         */
        type: "filter",
        path: "userId",
      },
    ],
  };

  if (current) {
    logger.info(
      { index: VECTOR_INDEX_NAME, status: current.status },
      "vector index already exists — updating definition",
    );
    await collection.updateSearchIndex(VECTOR_INDEX_NAME, definition);
  } else {
    await collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition,
    });
    logger.info({ index: VECTOR_INDEX_NAME }, "vector index created");
  }

  // Index builds are asynchronous. Reporting "created" while it is still
  // building would mean the next step queries an index that returns nothing.
  logger.info("waiting for index to become queryable...");
  const deadline = Date.now() + 300_000;

  while (Date.now() < deadline) {
    const [index] = (await collection
      .listSearchIndexes(VECTOR_INDEX_NAME)
      .toArray()) as SearchIndexInfo[];

    if (index?.queryable === true) {
      logger.info({ index: VECTOR_INDEX_NAME, status: index.status }, "vector index ready");
      await disconnectDatabase();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  logger.warn("timed out waiting for the index — check its status in Atlas");
  await disconnectDatabase();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "failed to ensure vector index");
  process.exit(1);
});
