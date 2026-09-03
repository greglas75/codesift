/**
 * Table definitions and the v1 -> v2 migration, as SQL text only.
 *
 * No behaviour here on purpose: `connection.ts` decides WHEN to run these, under which lock, and
 * what to record afterwards. Keeping the statements inert makes the schema readable as a schema.
 */

/**
 * v2 dropped the PRIMARY KEY on `symbols.id`.
 *
 * `id` is `repo:file:name:line`, which is NOT unique: a minified bundle puts hundreds of
 * distinct symbols on line 1 of one file, and PHPDoc `@method` synthesis emits a `field`
 * and a `method` at the same line. As a PRIMARY KEY with `ON CONFLICT DO UPDATE`, every
 * such collision silently overwrote the previous row — so the store quietly held fewer
 * symbols than it was given, and re-indexing reproduced the loss instead of repairing it.
 *
 * Measured over the 16 indexes that failed the migration's count check: 73,165 dropped
 * rows, every one carrying content different from the row that survived, and 7,514 of them
 * in real source rather than minified or vendored output.
 *
 * JSON never enforced uniqueness here, so this is parity, not a new tolerance. Lookups by
 * id return the first match exactly as the array scan did.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  language      TEXT NOT NULL,
  symbol_count  INTEGER NOT NULL,
  last_modified INTEGER NOT NULL,
  mtime_ms      INTEGER,
  stale         INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT NOT NULL,
  file        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_col   INTEGER,
  end_col     INTEGER,
  start_byte  INTEGER,
  end_byte    INTEGER,
  signature   TEXT,
  docstring   TEXT,
  source      TEXT,
  parent      TEXT,
  is_async    INTEGER,
  is_exported INTEGER,
  extras      TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_id ON symbols(id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);
`;

/*
 * Why `kind` and `parent` are indexed, and why that needed no schema version bump.
 *
 * Measured on this machine's largest index (352,166 symbols, 767 MB) BEFORE they existed:
 *
 *     WHERE name = ?     9 ms      (idx_symbols_name)
 *     WHERE file = ?    10 ms      (idx_symbols_file)
 *     WHERE kind = ?  2128 ms      full table scan
 *
 * Every predicate the tool layer filters on is one of those four columns, and `kind` and `parent`
 * are most of them: `sql-schema-tools.ts:94` (`kind === "field" && parent === sym.id`),
 * `react-compiler-tools.ts:61` (`kind === "component"`), `php-god-model-tools.ts:88` (methods per
 * class). Today each runs as a 352k-row scan in JS after materialising the whole index; they are
 * about to become SQL, and a scan in SQLite is no better than a scan in JS.
 *
 * After: kind 32 ms, parent 28 ms — 66x — and the file grew by nothing measurable.
 *
 * NO version bump, deliberately. `SCHEMA_SQL` runs on every open and every statement in it is
 * `IF NOT EXISTS`, so existing databases pick these up by themselves and there is nothing to
 * migrate. Bumping SCHEMA_VERSION would instead make every older CodeSift refuse these databases
 * outright ("written by a newer CodeSift"), trading a backward-compatible addition for a one-way
 * door. An older version simply does not use the new indexes.
 *
 * The one cost: an EXISTING large database builds them once, on its first open after the upgrade —
 * measured 2.26 s + 0.67 s on the 352k-symbol index, inside `openIndexDb`, on the daemon's thread.
 * A new database pays nothing, because the table is empty when the statements run.
 *
 * A composite `(file, kind)` was measured too (0.51 s to build, 26 ms to query) and left out on
 * purpose: `idx_symbols_file` already narrows a per-file query to a handful of rows, and every
 * index is paid again on WRITE — `saveIncrementalSqlite` deletes and re-inserts a file's rows on
 * each edit, and the PostToolUse hook fires that after every agent edit.
 */

/**
 * v1 -> v2: rebuild `symbols` without the PRIMARY KEY, keeping every row already stored.
 *
 * Rebuilt in place rather than by re-importing: for most repos the JSON source is gone, so
 * the db IS the index — dropping it to force a reindex would trade a store that is merely
 * incomplete for no store at all. This recovers nothing on its own; rows lost under v1 come
 * back when the repo is next indexed from source, which now keeps them.
 */
export const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE symbols RENAME TO symbols_v1;
CREATE TABLE symbols (
  id          TEXT NOT NULL,
  file        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_col   INTEGER,
  end_col     INTEGER,
  start_byte  INTEGER,
  end_byte    INTEGER,
  signature   TEXT,
  docstring   TEXT,
  source      TEXT,
  parent      TEXT,
  is_async    INTEGER,
  is_exported INTEGER,
  extras      TEXT
);
INSERT INTO symbols SELECT * FROM symbols_v1;
DROP TABLE symbols_v1;
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_id ON symbols(id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent);
`;
