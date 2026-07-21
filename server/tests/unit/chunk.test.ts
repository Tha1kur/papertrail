import { describe, expect, it } from "vitest";
import { chunkPages } from "../../src/services/rag/chunk.js";

function page(text: string, number = 1) {
  return { page: number, text };
}

describe("chunkPages", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkPages([page("A short paragraph about deployment windows.")]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("deployment windows");
  });

  it("splits long text into multiple chunks", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(60)}`).join(
      "\n\n",
    );
    const chunks = chunkPages([page(long)]);

    expect(chunks.length).toBeGreaterThan(1);
  });

  /**
   * Overlap is the reason a sentence spanning a boundary stays retrievable.
   * Without it, the half in chunk A and the half in chunk B both match the
   * question poorly and the answer is effectively unfindable.
   */
  it("overlaps consecutive chunks", () => {
    const long = Array.from({ length: 20 }, (_, i) => `Section ${i} ${"filler ".repeat(50)}`).join(
      "\n\n",
    );
    const chunks = chunkPages([page(long)]);

    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0]!;
    const second = chunks[1]!;
    const tail = first.content.slice(-60).trim().split(" ").slice(1).join(" ");

    expect(second.content.startsWith(tail.split(" ")[0] ?? "")).toBe(true);
  });

  it("carries the page number through to every chunk", () => {
    const chunks = chunkPages([page("First page text.", 1), page("Second page text.", 7)]);

    expect(chunks[0]?.page).toBe(1);
    expect(chunks[1]?.page).toBe(7);
  });

  it("numbers chunks continuously across pages", () => {
    const body = "sentence. ".repeat(400);
    const chunks = chunkPages([page(body, 1), page(body, 2)]);

    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("drops empty and whitespace-only pages", () => {
    const chunks = chunkPages([page(""), page("   \n\n  "), page("Real content here.")]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Real content here.");
  });

  /**
   * Minified data or a long base64 blob has no separators at all. The
   * splitter must still terminate and produce bounded chunks rather than
   * recursing forever or emitting one enormous piece.
   */
  it("splits text with no natural boundaries", () => {
    const chunks = chunkPages([page("x".repeat(10_000))]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("estimates tokens for every chunk", () => {
    const chunks = chunkPages([page("Some reasonably sized content for a chunk.")]);

    expect(chunks[0]?.tokens).toBeGreaterThan(0);
  });

  it("never emits an empty chunk", () => {
    const messy = "\n\n\n   Some text.\n\n\n\n   More text.   \n\n\n";
    const chunks = chunkPages([page(messy)]);

    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });
});
