/**
 * Shape of an Atlas Search index description.
 *
 * The driver types `listSearchIndexes()` as returning `{ name: string }`,
 * but the documents actually carry status and readiness fields that we need
 * — `queryable` in particular, since an index can exist while still being
 * built and will silently return nothing until it finishes.
 *
 * Declared here rather than sprinkling `as any` at each call site, so if the
 * driver's types improve later there is one place to delete.
 */
export interface SearchIndexInfo {
  name: string;
  /** BUILDING | READY | FAILED | PENDING | DELETING */
  status?: string;
  /** False while the index is still being built. */
  queryable?: boolean;
  latestDefinition?: unknown;
}
