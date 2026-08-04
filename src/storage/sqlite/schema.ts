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
`;

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
`;
