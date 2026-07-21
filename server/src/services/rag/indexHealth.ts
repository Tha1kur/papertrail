import ChunkModel from "../../models/Chunk.js";
import { logger } from "../../lib/logger.js";
import { VECTOR_INDEX_NAME } from "./retrieve.js";
import type { SearchIndexInfo } from "../../types/atlasSearch.js";

/**
 * Whether the vector index was queryable at boot.
 *
 * Cached rather than checked per request: listSearchIndexes is an Atlas
 * control-plane call, far too slow to sit in the path of a chat message.
 */
let vectorIndexReady = false;

export function isVectorIndexReady(): boolean {
  return vectorIndexReady;
}

/**
 * Checks the vector index at startup and says so loudly if it is missing.
 *
 * Retrieval degrades silently by design — chat should still work when
 * search is unavailable, rather than a missing index taking the whole
 * product down. But "degrades silently" is exactly how an outage goes
 * unnoticed for a week: every answer comes back confidently sourced from
 * nothing, and no request ever fails.
 *
 * So the quiet failure stays, and this makes sure somebody is told.
 */
export async function checkVectorIndex(): Promise<void> {
  try {
    const indexes = (await ChunkModel.collection
      .listSearchIndexes()
      .toArray()) as SearchIndexInfo[];
    const index = indexes.find((i) => i.name === VECTOR_INDEX_NAME);

    if (!index) {
      vectorIndexReady = false;
      logger.error(
        { index: VECTOR_INDEX_NAME },
        "vector index MISSING — document retrieval is disabled. Run: npm run ensure-index",
      );
      return;
    }

    if (index.queryable !== true) {
      vectorIndexReady = false;
      logger.warn(
        { index: VECTOR_INDEX_NAME, status: index.status },
        "vector index exists but is not queryable yet — retrieval will return nothing until it finishes building",
      );
      return;
    }

    vectorIndexReady = true;
    logger.info({ index: VECTOR_INDEX_NAME }, "vector index ready");
  } catch (err) {
    vectorIndexReady = false;
    // A cluster tier without Atlas Search support lands here. Worth a warning,
    // not worth refusing to start — everything except retrieval still works.
    logger.warn({ err }, "could not verify vector index — retrieval may be unavailable");
  }
}
