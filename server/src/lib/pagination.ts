import { BadRequestError } from "./errors.js";

/**
 * Keyset ("cursor") pagination rather than skip/limit.
 *
 * skip/limit has two failures that only appear once there is real data:
 *
 *   1. It is O(n) in the offset. The database walks and discards every
 *      skipped document, so page 500 is dramatically slower than page 1.
 *   2. It is unstable under concurrent writes. Insert a message while the
 *      user is paging and every subsequent page shifts by one — items get
 *      silently skipped or shown twice. In a chat log, where new messages
 *      arrive constantly, this is not an edge case.
 *
 * A cursor encodes the sort key of the last item seen, so the next query is
 * an index seek to that exact position — constant time, and unaffected by
 * anything inserted elsewhere.
 *
 * The timestamp alone is not unique: two documents written in the same
 * millisecond would make the boundary ambiguous and one of them would be
 * dropped. The _id is the tiebreaker, which is why every cursor carries both
 * and every sort names both.
 */
export interface Cursor {
  value: Date;
  id: string;
}

export type SortDirection = "asc" | "desc";

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.value.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("Malformed pagination cursor");
  }

  const separator = decoded.lastIndexOf("|");
  if (separator === -1) throw new BadRequestError("Malformed pagination cursor");

  const value = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(value.getTime()) || id.length === 0) {
    throw new BadRequestError("Malformed pagination cursor");
  }

  return { value, id };
}

/**
 * The filter for "everything strictly past this cursor", for a sort of
 * `{ [field]: dir, _id: dir }`.
 *
 * Both clauses must use the same direction as the sort, or the query walks
 * the index the wrong way and silently returns the page the user just read.
 */
export function pastCursor(
  cursor: Cursor,
  field: string,
  direction: SortDirection,
): Record<string, unknown> {
  const op = direction === "asc" ? "$gt" : "$lt";

  return {
    $or: [
      { [field]: { [op]: cursor.value } },
      { [field]: cursor.value, _id: { [op]: cursor.id } },
    ],
  };
}

/** The `sort` argument matching a cursor built on the same field. */
export function cursorSort(
  field: string,
  direction: SortDirection,
): Record<string, 1 | -1> {
  const dir = direction === "asc" ? 1 : -1;
  return { [field]: dir, _id: dir };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Fetching limit+1 rows is how we learn whether another page exists without
 * a second count query — which on a large collection costs more than the
 * page itself.
 */
export function buildPage<T>(rows: T[], limit: number, toCursor: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
  };
}

export function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(requested ?? fallback, 1), max);
}
