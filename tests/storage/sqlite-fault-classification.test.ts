import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  classifyStorageError,
  closeAllIndexDbs,
  getSymbolsForFileSqlite,
  isIndexStorageError,
  openIndexDb,
  saveIndexSqlite,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

/**
 * The classifier reads the field the driver actually populates.
 *
 * `node:sqlite` sets `code = "ERR_SQLITE_ERROR"` on EVERY fault and puts the real result code in
 * `errcode`. The allowlist was written against `code`, so for the entire life of that allowlist a
 * full disk, a readonly database and a permission failure classified as `null` — and `null` means
 * "not a storage fault", which every read path turns into "this repo has no index".
 *
 * The load-bearing test here is `classifies a REAL node:sqlite fault`: it captures an error from
 * the driver rather than constructing one that matches our belief about the driver. A synthetic
 * fixture cannot fail when the driver's error shape is not what we assumed — which is precisely
 * how this went unnoticed.
 */

let dir: string;

function makeIndex(overrides?: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols: [],
    files: [],
    created_at: 10,
    updated_at: 20,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

function bulkySymbols(n: number): CodeSymbol[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `test:big.ts:sym${i}:${i}`,
    repo: "test/repo",
    name: `sym${i}`,
    kind: "function" as const,
    file: "big.ts",
    start_line: i,
    end_line: i + 1,
    source: "x".repeat(2000),
  }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-fault-"));
});

afterEach(async () => {
  closeAllIndexDbs();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("classifyStorageError reads node:sqlite's numeric errcode", () => {
  it("classifies a REAL node:sqlite fault, not a synthetic shape", () => {
    // Captured from the driver. If node:sqlite ever changes how it reports faults, this test goes
    // red — which is the whole point; the previous fixtures could not.
    const dbPath = join(dir, "real.db");
    const writer = new DatabaseSync(dbPath);
    writer.exec("CREATE TABLE t(x)");
    writer.close();

    const readonly = new DatabaseSync(dbPath, { readOnly: true });
    let caught: unknown = null;
    try {
      readonly.exec("INSERT INTO t VALUES (1)");
    } catch (err) {
      caught = err;
    } finally {
      readonly.close();
    }

    expect(caught).not.toBeNull();
    // Before the fix this was `null`: `code` is "ERR_SQLITE_ERROR" and nothing looked at `errcode`.
    expect(classifyStorageError(caught)).toBe("SQLITE_READONLY");
  });

  it("maps the primary result codes the allowlist promises to classify", () => {
    const asFault = (errcode: number) => ({ code: "ERR_SQLITE_ERROR", errcode });
    expect(classifyStorageError(asFault(3))).toBe("SQLITE_PERM");
    expect(classifyStorageError(asFault(5))).toBe("SQLITE_BUSY");
    expect(classifyStorageError(asFault(8))).toBe("SQLITE_READONLY");
    expect(classifyStorageError(asFault(11))).toBe("SQLITE_CORRUPT");
    expect(classifyStorageError(asFault(13))).toBe("SQLITE_FULL");
    expect(classifyStorageError(asFault(14))).toBe("SQLITE_CANTOPEN");
    expect(classifyStorageError(asFault(26))).toBe("SQLITE_NOTADB");
  });

  it("folds extended result codes onto their primary", () => {
    // SQLite's extended codes are `primary | (sub << 8)`: 266 is SQLITE_IOERR_READ, 261 is
    // SQLITE_BUSY_RECOVERY. Reporting the primary keeps the vocabulary the allowlist speaks.
    expect(classifyStorageError({ errcode: 266 })).toBe("SQLITE_IOERR");
    expect(classifyStorageError({ errcode: 261 })).toBe("SQLITE_BUSY");
  });

  it("still refuses to classify what is not an operational fault", () => {
    // Absence must stay absence: SQLITE_CONSTRAINT (19) is a caller bug, not a sick store.
    expect(classifyStorageError({ code: "ERR_SQLITE_ERROR", errcode: 19 })).toBeNull();
    expect(classifyStorageError({ errcode: 1 })).toBeNull();
    expect(classifyStorageError(new Error("boom"))).toBeNull();
  });
});

describe("a failing write reports what actually went wrong", () => {
  it("survives SQLite's automatic rollback instead of being replaced by it", async () => {
    // SQLite auto-rolls back on SQLITE_FULL, so the explicit ROLLBACK in the catch used to throw
    // "cannot rollback - no transaction is active" and THAT propagated — a message that classifies
    // as nothing, replacing a perfectly good disk-full diagnosis.
    const dbPath = join(dir, "full.index.db");
    await saveIndexSqlite(dbPath, makeIndex());

    const db = await openIndexDb(dbPath);
    db.exec("PRAGMA max_page_count = 4"); // a synthetic full disk, without needing a full disk

    let caught: unknown = null;
    try {
      await saveIndexSqlite(dbPath, makeIndex({ symbols: bulkySymbols(4000) }));
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(String((caught as Error).message)).not.toMatch(/cannot rollback/i);
    // And it arrives classified: write paths had no classifying boundary at all, so this used to
    // reach the tool layer as an anonymous Error.
    expect(isIndexStorageError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("SQLITE_FULL");

    db.exec("PRAGMA max_page_count = 0");
  });
});

describe("an index from a newer CodeSift is a fault, not an empty repo", () => {
  it("throws an IndexStorageError so read paths cannot swallow it", async () => {
    const dbPath = join(dir, "newer.index.db");
    await saveIndexSqlite(dbPath, makeIndex());
    closeAllIndexDbs();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("99");
    raw.close();

    let caught: unknown = null;
    try {
      await openIndexDb(dbPath);
    } catch (err) {
      caught = err;
    }

    // A plain Error here was swallowed by every caller that does
    // `if (isIndexStorageError(err)) throw err;` and otherwise sets `index = null` — so the one
    // instruction that tells the user how to fix it never reached them.
    expect(isIndexStorageError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("SCHEMA_TOO_NEW");
    expect(String((caught as Error).message)).toMatch(/newer CodeSift/i);
  });
});

describe("a fault surfacing on the first page read is still a fault", () => {
  it("corrupt data pages reach the caller classified, not as an empty symbol list", async () => {
    // The dangerous shape: this accessor returns `[]` for legitimate absence, so an unclassified
    // fault here is indistinguishable from "this file has no symbols" — and nothing downstream
    // re-checks.
    //
    // Corrupting DATA pages rather than the header is the point. `CREATE TABLE IF NOT EXISTS` in
    // openIndexDb only consults sqlite_schema and succeeds on such a database; the first statement
    // that touches a real page is the `schema_version` meta read, which sat outside the
    // classifying guard and threw raw. Measured: every offset tried gives errcode 11
    // (SQLITE_CORRUPT) deterministically.
    const dbPath = join(dir, "corrupt.index.db");
    await saveIndexSqlite(dbPath, makeIndex({ symbols: bulkySymbols(400) }));
    closeAllIndexDbs();

    const handle = await open(dbPath, "r+");
    try {
      await handle.write(Buffer.alloc(32768, 0x7a), 0, 32768, 65536);
    } finally {
      await handle.close();
    }

    let caught: unknown = null;
    try {
      await getSymbolsForFileSqlite(dbPath, "big.ts");
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(isIndexStorageError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("SQLITE_CORRUPT");
  });
});
