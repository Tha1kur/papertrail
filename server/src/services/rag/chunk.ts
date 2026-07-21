import type { ExtractedPage } from "./extract.js";
import { estimateTokens } from "../context/tokens.js";
import { env } from "../../config/env.js";

export interface TextChunk {
  index: number;
  content: string;
  page: number;
  tokens: number;
}

/**
 * Roughly 175 tokens. Chunk size cuts both ways:
 *
 *   - too large, and one chunk covers several topics. Its embedding becomes
 *     an average of all of them and matches none of them well
 *   - too small, and a passage loses the context that made it meaningful.
 *     "It rose by 12%" is unretrievable without knowing what "it" is
 *
 * Both halves of that were observed, not assumed — see the measurements in
 * config/env.ts. The default came from running the eval harness at three
 * sizes, not from picking a number that sounded reasonable.
 */
const TARGET_CHARS = env.CHUNK_TARGET_CHARS;

/**
 * Overlap exists for boundaries. A sentence answering the question could
 * otherwise be split across two chunks, leaving each half matching poorly
 * and the answer effectively unfindable. Repeating the tail of one chunk at
 * the head of the next means every sentence appears intact somewhere.
 *
 * The cost is storage and some duplicate results, which is cheap next to
 * silently failing to retrieve.
 */
const OVERLAP_CHARS = env.CHUNK_OVERLAP_CHARS;

/** Below this, a trailing fragment is merged backwards rather than kept as
 *  its own chunk — a 20-character chunk carries no usable meaning. */
const MIN_CHARS = 120;

/**
 * Splits pages into overlapping chunks, preferring natural boundaries.
 *
 * The separator list is ordered by how much meaning the break preserves:
 * paragraphs first, then lines, then sentences, then words. Splitting at a
 * fixed character count regardless of content is what produces chunks
 * beginning mid-word, and embeddings of those are measurably worse.
 */
export function chunkPages(pages: ExtractedPage[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  let index = 0;

  for (const page of pages) {
    for (const content of splitText(page.text)) {
      chunks.push({
        index,
        content,
        page: page.page,
        tokens: estimateTokens(content),
      });
      index += 1;
    }
  }

  return chunks;
}

function splitText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= TARGET_CHARS) return [trimmed];

  const pieces = splitRecursive(trimmed, ["\n\n", "\n", ". ", " "]);
  return withOverlap(mergeSmall(pieces));
}

/**
 * Splits on the coarsest separator that yields pieces under the target,
 * recursing into any piece still too large.
 */
function splitRecursive(text: string, separators: readonly string[]): string[] {
  if (text.length <= TARGET_CHARS) return [text];

  const [separator, ...rest] = separators;

  // Out of separators: the text is one unbroken run, so cut it by length.
  // A single 5,000-character "word" is pathological but does occur — minified
  // data pasted into a document, for instance.
  if (separator === undefined) {
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += TARGET_CHARS) {
      pieces.push(text.slice(i, i + TARGET_CHARS));
    }
    return pieces;
  }

  const parts = text.split(separator);
  if (parts.length === 1) return splitRecursive(text, rest);

  const pieces: string[] = [];
  let buffer = "";

  for (const part of parts) {
    const candidate = buffer.length === 0 ? part : `${buffer}${separator}${part}`;

    if (candidate.length <= TARGET_CHARS) {
      buffer = candidate;
      continue;
    }

    if (buffer.length > 0) pieces.push(buffer);

    // The part alone may still be over target; recurse with finer separators.
    if (part.length > TARGET_CHARS) {
      pieces.push(...splitRecursive(part, rest));
      buffer = "";
    } else {
      buffer = part;
    }
  }

  if (buffer.length > 0) pieces.push(buffer);
  return pieces;
}

/** Folds an undersized trailing piece into its predecessor. */
function mergeSmall(pieces: string[]): string[] {
  const merged: string[] = [];

  for (const piece of pieces) {
    const previous = merged.at(-1);

    if (piece.length < MIN_CHARS && previous !== undefined) {
      merged[merged.length - 1] = `${previous} ${piece}`;
    } else {
      merged.push(piece);
    }
  }

  return merged;
}

/**
 * Prepends the tail of each chunk to the one after it, cut at a word
 * boundary so the overlap does not begin mid-word.
 */
function withOverlap(pieces: string[]): string[] {
  if (pieces.length <= 1) return pieces.map((p) => p.trim()).filter((p) => p.length > 0);

  return pieces
    .map((piece, i) => {
      if (i === 0) return piece.trim();

      const previous = pieces[i - 1] ?? "";
      const tail = previous.slice(-OVERLAP_CHARS);
      const boundary = tail.indexOf(" ");
      const overlap = boundary === -1 ? tail : tail.slice(boundary + 1);

      return `${overlap} ${piece}`.trim();
    })
    .filter((p) => p.length > 0);
}
