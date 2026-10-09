// ADR-006, write half of stage 1: a whole-index save through the Rust core must leave a database
// byte-for-byte equal to the TypeScript save — same rows in the same rowid order, same storage TYPES
// (an integral number INTEGER, a fractional mtime REAL), same extras text, same meta.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { saveIndexSqlite } from "../../src/storage/sqlite/index-io.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { getNativeCore, resetNativeForTesting } from "../../src/native/index.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// The store is opt-in only (see OPT_IN_ONLY in src/native/index.ts), so these suites opt in.
const native = (() => {
  const prev = process.env["CODESIFT_NATIVE_STORE"];
  process.env["CODESIFT_NATIVE_STORE"] = "1";
  resetNativeForTesting();
  try {
    return getNativeCore("store");
  } catch {
    return null;
  } finally {
    if (prev === undefined) delete process.env["CODESIFT_NATIVE_STORE"];
    else process.env["CODESIFT_NATIVE_STORE"] = prev;
  }
})();

let dir: string;

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}

function fixture(): CodeIndex {
  const symbols: CodeSymbol[] = [
    sym({ id: "t:a.ts:f:1", name: "f", source: "function f() {}", signature: "()", docstring: "/** d */", is_async: true, is_exported: false, start_col: 0, end_col: 2, start_byte: 0, end_byte: 15, tokens: ["f"], decorators: ["@x"], extends: ["B"], implements: ["I"], meta: { z: 1, a: [1, "two", null, true], f: 1.5, n: { deep: -0.25 } } }),
    sym({ id: "t:a.ts:f:1", name: "f", kind: "variable" }),
    sym({ id: "t:b.ts:zażółć:3", name: "zażółć", file: "b.ts", docstring: "中文 🚀 \"q\" \\ \n\t", parent: "t:a.ts:f:1" }),
    sym({ id: "t:c.ts:empty:1", name: "empty", file: "c.ts", source: "", signature: "" }),
    ...Array.from({ length: 12_000 }, (_, i) => sym({ id: `t:g.ts:n${i}:${i}`, name: `n${i}`, file: "g.ts", start_line: i, end_line: i + 1, tokens: i % 3 ? undefined : ["n"] })),
  ];
  return {
    repo: "t",
    root: "/tmp/t",
    symbols,
    files: [
      { path: "a.ts", language: "typescript", symbol_count: 2, last_modified: 1_700_000_000_000, mtime_ms: 1_700_000_000_123.456 },
      { path: "b.ts", language: "typescript", symbol_count: 1, last_modified: 1_700_000_000_001, mtime_ms: 1_700_000_000_001, stale: true },
      { path: "c.ts", language: "typescript", symbol_count: 1, last_modified: 2, stale: false },
    ],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    symbol_count: symbols.length,
    file_count: 3,
    extractor_version: { typescript: "7" },
  };
}

function dump(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => `quote(${c.name})`).join(" || '|' || ");
    const rows = (sql: string) => (db.prepare(sql).all() as Array<{ r: string }>).map((x) => x.r).join("\n");
    return [
      rows(`SELECT ${cols("symbols")} AS r FROM symbols ORDER BY rowid`),
      rows(`SELECT ${cols("files")} AS r FROM files ORDER BY rowid`),
      rows("SELECT quote(key) || '=' || quote(value) AS r FROM meta ORDER BY key"),
    ].join("\n--\n");
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-write-parity-"));
});

afterAll(() => {
  closeAllIndexDbs();
  delete process.env["CODESIFT_NATIVE_STORE"];
  resetNativeForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!native)("native whole-index write parity with the TypeScript writer", () => {
  it("writes the identical database, types and order included", async () => {
    const index = fixture();
    const tsPath = join(dir, "ts.index.db");
    const rsPath = join(dir, "rs.index.db");
    process.env["CODESIFT_NATIVE_STORE"] = "0";
    await saveIndexSqlite(tsPath, index, { sourceComplete: true });
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    await saveIndexSqlite(rsPath, index, { sourceComplete: true });
    closeAllIndexDbs();
    const a = dump(tsPath);
    const b = dump(rsPath);
    expect(b.length).toBeGreaterThan(1000);
    expect(b).toBe(a);
  });

  it("replaces an existing index rather than appending to it", async () => {
    const rsPath = join(dir, "replace.index.db");
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    const first = fixture();
    await saveIndexSqlite(rsPath, first);
    const second = { ...first, symbols: first.symbols.slice(0, 3), symbol_count: 3, files: first.files.slice(0, 1), file_count: 1 };
    await saveIndexSqlite(rsPath, second);
    closeAllIndexDbs();
    const db = new DatabaseSync(rsPath, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    const f = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    db.close();
    expect([n, f]).toEqual([3, 1]);
  });
});
