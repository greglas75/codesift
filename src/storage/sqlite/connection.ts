import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { rethrowOperational } from "./errors.js";
import { loadSqliteCtor } from "./runtime.js";
import { MIGRATE_V1_TO_V2_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/**
 * Connection handling, schema creation, migration, and the `meta` key/value accessors.
 *
 * The open-connection cache lives HERE and nowhere else. One cache is the whole point: two
 * modules each holding their own `connections` map would each hand out a different handle for the
 * same path, so `closeIndexDb` would close one and leave the other open, and a write through one
 * would be invisible to a `PRAGMA data_version` read through the other. Type-checking, linting and
 * most tests all pass over that, which is exactly why it is called out.
 */

const connections = new Map<string, DatabaseSyncType>();

/**
 * Open (and cache) a connection, creating the schema on first use.
 *
 * WAL is the reason this migration solves a problem a sharded JSON layout would not: the MCP
 * server and the `codesift postindex-file` hook are separate processes writing the same
 * index, and WAL gives them concurrent readers with a single writer instead of a corruption
 * window. `busy_timeout` makes a writer wait its turn rather than throwing SQLITE_BUSY when
 * an agent edits files faster than the previous write settles.
 */
export async function openIndexDb(dbPath: string): Promise<DatabaseSyncType> {
  const cached = connections.get(dbPath);
  if (cached) return cached;

  const Ctor = await loadSqliteCtor();
  if (!Ctor) throw new Error("node:sqlite is unavailable (requires Node >= 22.5)");

  if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });

  let db: DatabaseSyncType | undefined;
  try {
    db = new Ctor(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  } catch (err) {
    // Close before rethrowing: the constructor can succeed and a PRAGMA still fail, and this
    // handle never reaches the `connections` cache, so nothing else would ever close it. On a
    // retry loop against a sick database that leaks a descriptor and a lock per attempt —
    // which makes the very BUSY/EMFILE conditions being reported worse.
    try {
      db?.close();
    } catch {
      /* already dead — the original fault is the one worth reporting */
    }
    // A corrupt or unopenable file fails here, before any row is read — the one place where
    // "cannot open" would otherwise look exactly like "nothing indexed yet".
    rethrowOperational(err, dbPath);
  }

  const stored = readMetaValue(db, "schema_version");
  if (stored === undefined) {
    writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
  } else if (Number(stored) > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Index at ${dbPath} was written by a newer CodeSift (schema v${stored} > v${SCHEMA_VERSION}). Upgrade codesift-mcp.`,
    );
  } else if (Number(stored) < SCHEMA_VERSION) {
    // One transaction: a half-applied table swap would leave `symbols_v1` as the only copy
    // of the rows, under a name nothing reads.
    try {
      db.exec("BEGIN IMMEDIATE");
      // Re-read UNDER the lock. The version above was read before `BEGIN IMMEDIATE`, so two
      // processes opening the same index at once both saw `stored < 2` and both queued the
      // migration; the second then re-copied a table that was already v2. Harmless — v2 has no
      // PRIMARY KEY, so nothing is dropped — but it is a full-table copy of a repo-sized table
      // done for nothing, and on a large index that is seconds of wall clock plus the disk churn.
      // The lock is the only point at which the answer is stable, so this is where to ask.
      // Fall through rather than return early: the connection still has to reach `connections`
      // below, and an early return here would quietly stop caching it for the racing process.
      const current = Number(readMetaValue(db, "schema_version") ?? 0);
      if (current < SCHEMA_VERSION && current < 2) {
        db.exec(MIGRATE_V1_TO_V2_SQL);
        // The rebuild keeps every row the v1 table still HELD — it cannot bring back the ones
        // v1 already discarded on id collision (73,165 across 16 indexes when this was found).
        // Without this marker the upgraded database looks like any other complete v2 index, so
        // a caller would read a short symbol list as a fact about the code. Only a full reindex
        // from source can restore them, and `saveIndexSqlite` clears the flag when it does.
        writeMetaValue(db, "lossy_v1_migration", "1");
      }
      if (current < SCHEMA_VERSION) {
        writeMetaValue(db, "schema_version", String(SCHEMA_VERSION));
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* nothing left to roll back */ }
      try { db.close(); } catch { /* already dead */ }
      rethrowOperational(err, dbPath);
    }
  }

  connections.set(dbPath, db);
  return db;
}

/** Close one cached connection (tests, and the shutdown path). */
export function closeIndexDb(dbPath: string): void {
  const db = connections.get(dbPath);
  if (!db) return;
  connections.delete(dbPath);
  try {
    db.close();
  } catch {
    /* already closed — nothing to protect here */
  }
}

export function closeAllIndexDbs(): void {
  for (const path of [...connections.keys()]) closeIndexDb(path);
}

/**
 * Open a second connection for reading only.
 *
 * The paged read in `index-io.ts` yields to the event loop between pages, and the cached
 * connection is shared by every request in this process — so a write landing mid-traversal would
 * let one `CodeIndex` be assembled out of two different database states. Holding a read
 * transaction on the SHARED connection cannot fix that: any write arriving during the yield would
 * hit "cannot start a transaction within a transaction".
 *
 * A private connection in WAL mode sees a stable snapshot from `BEGIN` to `COMMIT` regardless of
 * what other connections commit meanwhile. It costs one open per cold load, which happens once
 * per process per repo.
 */
export async function openReadConnection(dbPath: string): Promise<DatabaseSyncType> {
  const Ctor = await loadSqliteCtor();
  if (!Ctor) throw new Error("node:sqlite is unavailable (requires Node >= 22.5)");
  const db = new Ctor(dbPath);
  // The constructor can succeed and the PRAGMA still fail — corruption and I/O faults often
  // surface on the first statement, not at open. This handle never reaches the `connections`
  // cache, and the caller's `finally` only closes what it managed to assign, so an unguarded
  // throw here leaks a descriptor on every attempt. Same guard as `openIndexDb`, same reason;
  // it was missing here only because this connection is deliberately not cached.
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (err) {
    try { db.close(); } catch { /* already unusable — the leak is what we came to prevent */ }
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// meta helpers
// ---------------------------------------------------------------------------

export function readMetaValue(db: DatabaseSyncType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function writeMetaValue(db: DatabaseSyncType, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
