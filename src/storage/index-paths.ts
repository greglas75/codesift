/**
 * The index path convention, in a module with no imports: CLI hooks derive the SQLite store from a registry
 * `index_path` on every tool call and must not load the storage layer to do it. `index-migration.ts` re-exports
 * both, so the storage layer's callers see one definition.
 */

/** Reject SQLite artifacts where callers must provide the canonical index path. */
export function assertCanonicalIndexPath(indexPath: string): void {
  if (/\.db(?:-(?:wal|shm|journal))?(?:\.json)?$/i.test(indexPath)) {
    throw new TypeError(
      `Expected a canonical index path, received SQLite database path: ${indexPath}`,
    );
  }
}

/**
 * Keep both formats side by side so the JSON file remains a usable rollback artifact.
 * Throws when given an already-derived SQLite file or sidecar: accepting one would silently
 * derive a second, unrelated database path.
 */
export function sqlitePathFor(indexPath: string): string {
  assertCanonicalIndexPath(indexPath);
  return indexPath.endsWith(".json")
    ? `${indexPath.slice(0, -".json".length)}.db`
    : `${indexPath}.db`;
}
