/**
 * SQLite backend for the per-repo index. See docs/adr/ADR-003-index-storage-format.md.
 *
 * The point of this module is NOT that SQL is nicer than JSON. It is that the JSON blob
 * forced every write to cost the size of the whole repo: `saveIncremental` re-parsed and
 * re-serialised 262 MB to record one edited file, and the PostToolUse hook — a fresh process
 * per edit, so it can never batch — paid that on every single Write/Edit an agent made.
 * Here a one-file re-index touches one row.
 *
 * Fidelity over elegance: hot fields get real columns (so a full load builds objects without
 * parsing anything), and the rarely-populated tail (`tokens`, `decorators`, `extends`,
 * `implements`, `meta`) is kept as one JSON `extras` column. That keeps the round-trip
 * lossless for language-specific fields nobody here should have to know about, while the
 * common symbol costs zero JSON.parse calls.
 *
 * ---------------------------------------------------------------------------
 *
 * This file is the FACADE. The implementation lives in `./sqlite/`:
 *
 *     runtime.ts     is node:sqlite present, and the memoised constructor
 *     errors.ts      operational fault vs "nothing indexed here"
 *     schema.ts      table definitions and the v1 -> v2 migration, as SQL text
 *     rows.ts        row <-> domain mapping, and the byte accounting for it
 *     connection.ts  open/close/cache, schema creation, migration, meta k/v
 *     meta.ts        the optional meta fields, and the summary shape
 *     index-io.ts    whole-index read and write — the paths that touch every row
 *     accessors.ts   narrow reads that never materialise the index
 *
 * The path stays because 12 modules import it; keeping it as a re-export means the split is
 * provably behaviour-preserving rather than an API change dressed as a refactor.
 *
 * Two invariants this arrangement rests on, both invisible to a type-check:
 *
 *   - The memoised `node:sqlite` constructor lives ONLY in `runtime.ts`, and the open-connection
 *     cache ONLY in `connection.ts`. ESM gives one instance per module, so re-exporting is safe
 *     and re-DECLARING is not: a second copy of either forks the state, and the result is a
 *     `closeIndexDb` that closes a handle somebody else is still handing out.
 *     `tests/storage/sqlite-module-state.test.ts` fails on exactly that fork.
 *   - The re-exports below are an explicit list, not `export *`. Adding an export to a submodule
 *     should be a decision about this facade, not a side effect of writing a helper.
 */

export { isSqliteAvailable, loadSqliteCtor, setSqliteCtorForTesting } from "./sqlite/runtime.js";

export { IndexStorageError, classifyStorageError, isIndexStorageError } from "./sqlite/errors.js";

export { SCHEMA_VERSION } from "./sqlite/schema.js";

export { closeAllIndexDbs, closeIndexDb, openIndexDb } from "./sqlite/connection.js";

export type { IndexSummary } from "./sqlite/meta.js";

export {
  importLegacyIndexIfEmpty,
  loadIndexSqlite,
  saveIndexSqlite,
  wasLossilyMigrated,
} from "./sqlite/index-io.js";

export {
  getDataVersion,
  getFileEntrySqlite,
  getFileMtimeSqlite,
  getSymbolsForFileSqlite,
  loadIndexSummarySqlite,
  removeFileFromIndexSqlite,
  saveIncrementalSqlite,
  indexDbIsPopulated,
} from "./sqlite/accessors.js";
