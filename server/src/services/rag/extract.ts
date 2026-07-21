import { extractText, getDocumentProxy } from "unpdf";
import { BadRequestError } from "../../lib/errors.js";

export interface ExtractedPage {
  /** 1-based, so it matches what the user sees in a PDF reader. */
  page: number;
  text: string;
}

export interface Extraction {
  pages: ExtractedPage[];
  characters: number;
}

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
] as const;

export function isSupported(mimeType: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Pulls text out of an upload, page by page where the format has pages.
 *
 * Keeping pages separate rather than concatenating everything is what makes
 * citations useful: "page 14" is something the user can act on, whereas
 * "somewhere in this 200-page PDF" is not.
 */
export async function extract(buffer: Buffer, mimeType: string): Promise<Extraction> {
  if (mimeType === "application/pdf") return extractPdf(buffer);

  if (mimeType.startsWith("text/")) {
    const text = buffer.toString("utf8");
    return { pages: [{ page: 1, text }], characters: text.length };
  }

  throw new BadRequestError(`Unsupported file type: ${mimeType}`);
}

async function extractPdf(buffer: Buffer): Promise<Extraction> {
  let pageTexts: string[];

  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    // mergePages:false keeps the per-page split we need for citations.
    const result = await extractText(pdf, { mergePages: false });
    pageTexts = Array.isArray(result.text) ? result.text : [result.text];
  } catch (err) {
    // An unparseable PDF is the user's problem to fix, not a server fault,
    // so it must surface as a 400 with something actionable.
    throw new BadRequestError(
      "Could not read that PDF — it may be corrupt or password protected",
      err instanceof Error ? { reason: err.message } : undefined,
    );
  }

  const pages: ExtractedPage[] = [];
  let characters = 0;

  for (const [index, raw] of pageTexts.entries()) {
    const text = normalise(raw ?? "");
    if (text.length === 0) continue;

    pages.push({ page: index + 1, text });
    characters += text.length;
  }

  /**
   * A scanned PDF is images with no text layer, so extraction returns
   * nothing at all. Left unchecked this produces a document with zero
   * chunks that silently answers nothing — the user uploads a file, sees
   * "ready", and then wonders why the assistant has never heard of it.
   * OCR would be the fix; saying so plainly is the honest interim.
   */
  if (characters === 0) {
    throw new BadRequestError(
      "No text found in that PDF. If it is a scan, it needs OCR before it can be searched.",
    );
  }

  return { pages, characters };
}

/**
 * PDF extraction produces text that is technically correct and practically
 * awful: hyphenated line breaks mid-word, hard wraps inside sentences, runs
 * of whitespace from column layout. Left alone, all of it ends up inside
 * embeddings, where it adds noise to every similarity comparison.
 */
function normalise(text: string): string {
  return (
    text
      // Rejoin words split across a line break: "under-\nstanding".
      .replace(/(\w)-\n(\w)/g, "$1$2")
      // A single newline inside a paragraph is a layout artefact, not a
      // break in meaning. Two or more is a real paragraph boundary.
      .replace(/([^\n])\n(?!\n)/g, "$1 ")
      .replace(/[ \t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
