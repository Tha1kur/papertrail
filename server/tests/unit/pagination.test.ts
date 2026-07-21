import { describe, expect, it } from "vitest";
import {
  buildPage,
  clampLimit,
  cursorSort,
  decodeCursor,
  encodeCursor,
  pastCursor,
} from "../../src/lib/pagination.js";
import { BadRequestError } from "../../src/lib/errors.js";

describe("cursor encoding", () => {
  it("round-trips a cursor", () => {
    const cursor = { value: new Date("2026-07-21T10:30:00.000Z"), id: "abc123" };
    const decoded = decodeCursor(encodeCursor(cursor));

    expect(decoded.value.toISOString()).toBe(cursor.value.toISOString());
    expect(decoded.id).toBe(cursor.id);
  });

  it("survives ids containing the separator", () => {
    // The decoder splits on the *last* separator for exactly this reason.
    const cursor = { value: new Date("2026-01-01T00:00:00.000Z"), id: "we|ird|id" };
    expect(decodeCursor(encodeCursor(cursor)).id).toBe("we|ird|id");
  });

  it("rejects malformed cursors rather than silently misbehaving", () => {
    // A bad cursor is client input. Left unvalidated it becomes an Invalid
    // Date, which compares false against everything and returns an empty
    // page — a silent wrong answer instead of an error.
    expect(() => decodeCursor("not-a-cursor")).toThrow(BadRequestError);
    expect(() => decodeCursor(Buffer.from("no-separator").toString("base64url"))).toThrow(
      BadRequestError,
    );
    expect(() => decodeCursor(Buffer.from("not-a-date|id").toString("base64url"))).toThrow(
      BadRequestError,
    );
  });
});

describe("pastCursor", () => {
  const cursor = { value: new Date("2026-07-21T10:00:00.000Z"), id: "m5" };

  /**
   * The tiebreaker is the point. Two documents written in the same
   * millisecond would otherwise sit on an ambiguous boundary and one of them
   * would be silently skipped between pages.
   */
  it("includes an _id tiebreaker for identical timestamps", () => {
    const filter = pastCursor(cursor, "createdAt", "asc") as {
      $or: Array<Record<string, unknown>>;
    };

    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toEqual({ createdAt: { $gt: cursor.value } });
    expect(filter.$or[1]).toEqual({ createdAt: cursor.value, _id: { $gt: cursor.id } });
  });

  it("flips the comparison for descending order", () => {
    const filter = pastCursor(cursor, "lastMessageAt", "desc") as {
      $or: Array<Record<string, unknown>>;
    };

    expect(filter.$or[0]).toEqual({ lastMessageAt: { $lt: cursor.value } });
  });

  /**
   * A filter walking one way and a sort walking the other returns the page
   * the user just read — an infinite loop in the UI that looks like the
   * server "not returning more results".
   */
  it("matches the direction of its sort", () => {
    expect(cursorSort("createdAt", "asc")).toEqual({ createdAt: 1, _id: 1 });
    expect(cursorSort("lastMessageAt", "desc")).toEqual({ lastMessageAt: -1, _id: -1 });
  });
});

describe("buildPage", () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    createdAt: new Date(2026, 0, i + 1),
    _id: `id-${i}`,
  }));
  const toCursor = (row: (typeof rows)[number]) => ({ value: row.createdAt, id: row._id });

  it("detects more pages by over-fetching one row", () => {
    const page = buildPage(rows, 10, toCursor);

    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("reports no more pages when the result is short", () => {
    const page = buildPage(rows.slice(0, 5), 10, toCursor);

    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("points the next cursor at the last returned item, not the extra row", () => {
    const page = buildPage(rows, 10, toCursor);
    const decoded = decodeCursor(page.nextCursor!);

    // Off by one here means row 10 is skipped entirely between pages.
    expect(decoded.id).toBe("id-9");
  });

  it("handles an empty result", () => {
    const page = buildPage([], 10, toCursor);

    expect(page).toEqual({ items: [], hasMore: false, nextCursor: null });
  });
});

describe("clampLimit", () => {
  it("applies the default when unspecified", () => {
    expect(clampLimit(undefined, 30, 50)).toBe(30);
  });

  it("caps at the maximum so a client cannot request everything", () => {
    expect(clampLimit(10_000, 30, 50)).toBe(50);
  });

  it("floors at one, so zero or negative cannot produce an empty page forever", () => {
    expect(clampLimit(0, 30, 50)).toBe(1);
    expect(clampLimit(-5, 30, 50)).toBe(1);
  });
});
