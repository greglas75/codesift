// Which columns the tool layer filters on, and whether SQLite can answer without a full scan.
//
// Measured on this machine's largest index (352,166 symbols, 767 MB) before these existed:
//   WHERE name = ?  9 ms · WHERE file = ? 10 ms · WHERE kind = ? 2128 ms (full scan)
// `kind` and `parent` are most of what the tool layer actually filters on — sql-schema-tools.ts:94,
// react-compiler-tools.ts:61, php-god-model-tools.ts:88 — and those predicates are about to become
// SQL. A scan in SQLite is no better than the scan in JS it replaces.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, MIGRATE_V1_TO_V2_SQL } from "../../src/storage/sqlite/schema.js";

let dir: string;
let db: InstanceType<typeof DatabaseSync>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-idx-"));
  db = new DatabaseSync(join(dir, "x.db"));
  db.exec(SCHEMA_SQL);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function indexNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbols'")
    .all() as Array<{ name: string }>).map((r) => r.name).sort();
}

/** The query planner is the only authority on whether an index is actually usable. */
function planFor(sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

describe("symbols indexes", () => {
  it("covers every column the tool layer filters on", () => {
    expect(indexNames()).toEqual(expect.arrayContaining([
      "idx_symbols_file", "idx_symbols_name", "idx_symbols_id",
      "idx_symbols_kind", "idx_symbols_parent",
    ]));
  });

  it("uses an index for kind and parent rather than scanning", () => {
    // Asserting on the PLAN, not on a timing: a timing test on an empty fixture proves nothing,
    // and the fault being prevented is precisely "the planner fell back to a scan".
    expect(planFor("SELECT * FROM symbols WHERE kind = 'function'")).toMatch(/idx_symbols_kind/);
    expect(planFor("SELECT * FROM symbols WHERE parent = 'x'")).toMatch(/idx_symbols_parent/);
    expect(planFor("SELECT * FROM symbols WHERE kind = 'function'")).not.toMatch(/SCAN symbols(?!.*USING)/);
  });

  it("still uses the older indexes — this adds, it does not replace", () => {
    expect(planFor("SELECT * FROM symbols WHERE name = 'x'")).toMatch(/idx_symbols_name/);
    expect(planFor("SELECT * FROM symbols WHERE file = 'a.ts'")).toMatch(/idx_symbols_file/);
  });

  it("is idempotent, which is what lets an existing database pick it up with no migration", () => {
    // SCHEMA_SQL runs on EVERY open. That is the whole reason this needed no version bump — and a
    // bump would have made older CodeSift refuse these databases outright.
    expect(() => { db.exec(SCHEMA_SQL); db.exec(SCHEMA_SQL); }).not.toThrow();
    expect(indexNames().length).toBe(new Set(indexNames()).size);
  });

  it("the v1 migration produces the same index set as a fresh schema", () => {
    // Otherwise a database that arrived through the migration would quietly scan where a fresh one
    // seeks, and nothing would ever say so.
    const fresh = indexNames();
    const migrated = mkdtempSync(join(tmpdir(), "cs-idx-mig-"));
    const old = new DatabaseSync(join(migrated, "v1.db"));
    try {
      old.exec(`CREATE TABLE symbols (
        id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_col INTEGER, end_col INTEGER,
        start_byte INTEGER, end_byte INTEGER, signature TEXT, docstring TEXT, source TEXT,
        parent TEXT, is_async INTEGER, is_exported INTEGER, extras TEXT);`);
      old.exec(MIGRATE_V1_TO_V2_SQL);
      const got = (old.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbols'")
        .all() as Array<{ name: string }>).map((r) => r.name).sort();
      expect(got).toEqual(fresh);
    } finally {
      old.close();
      rmSync(migrated, { recursive: true, force: true });
    }
  });
});
