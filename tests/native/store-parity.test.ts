// ADR-006 stage 1: the Rust read path must answer exactly what the TypeScript one answers — same
// symbols, same order, same keys in the same order (tools serialise symbols, so key order is
// output), same absent-vs-null distinctions. A difference here is a silently different tool answer.
//
// Runs only when the native core is loaded (the CI `native` job and farm runs build it); without a
// binary there is nothing to compare, and tests/native/loader.test.ts is what fails a run that
// required one.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../../src/storage/sqlite/schema.js";
import { INSERT_SYMBOL_SQL, symbolToRow } from "../../src/storage/sqlite/rows.js";
import {
  findSymbolsSqlite,
  getIndexMetaSqlite,
  rethrowNative,
  streamSymbolsSqlite,
  type SymbolQuery,
} from "../../src/storage/sqlite/queries.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { isIndexStorageError } from "../../src/storage/sqlite/errors.js";
import { getNativeCore, resetNativeForTesting } from "../../src/native/index.js";
import type { CodeSymbol } from "../../src/types.js";

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
let dbPath: string;
const savedStore = process.env["CODESIFT_NATIVE_STORE"];

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}

const SYMBOLS: CodeSymbol[] = [
  sym({ id: "t:a.ts:createUser:1", name: "createUser", signature: "(name: string): User", docstring: "Makes a user.", source: "function createUser(name) {}", is_async: true, is_exported: true, start_col: 0, end_col: 3, start_byte: 0, end_byte: 40, tokens: ["create", "user"], decorators: ["@x"], meta: { z: 1, a: { nested: [1, "two", null, true] }, "10": "int-like key", f: 1.5 } }),
  sym({ id: "t:a.ts:createUser:1", name: "createUser", kind: "variable", is_async: false, is_exported: false }), // id collision
  sym({ id: "t:b.ts:UserModel:3", name: "UserModel", kind: "class", file: "b.ts", parent: "mod", extends: ["Base"], implements: ["I"], source: "" }),
  sym({ id: "t:b.ts:a_b:9", name: "a_b", file: "b.ts", signature: "" }),
  sym({ id: "t:b.ts:a%b:9", name: "a%b", file: "b.ts" }),
  sym({ id: "t:b.ts:axb:9", name: "axb", file: "b.ts" }),
  sym({ id: "t:c.ts:zażółć:1", name: "zażółć", file: "c.ts", docstring: "Gęślą jaźń — 中文注释 — emoji 🚀 — \"quoted\" \\ backslash\n\ttab" }),
  sym({ id: "t:c.ts:get_thing:2", name: "get_thing", file: "c.ts", kind: "method", parent: "t:b.ts:UserModel:3" }),
  ...Array.from({ length: 1500 }, (_, i) => sym({ id: `t:gen.ts:n${i}:${i}`, name: `n${i}`, file: "gen.ts", start_line: i, kind: i % 7 === 0 ? "class" : "function" })),
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-parity-"));
  dbPath = join(dir, "x.index.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.exec("INSERT INTO meta (key,value) VALUES ('repo','t'),('root','/tmp/t'),('updated_at','4242')");
    db.exec("BEGIN");
    const stmt = db.prepare(INSERT_SYMBOL_SQL);
    for (const s of SYMBOLS) stmt.run(...(symbolToRow(s) as never[]));
    // Values the writer never produces but a database can hold: a stored JSON null in extras, and
    // an extras key the mapper must ignore.
    db.exec(`INSERT INTO symbols (id,file,name,kind,start_line,end_line,extras)
             VALUES ('t:d.ts:odd:1','d.ts','odd','function',1,1,'{"tokens":null,"unknown":1,"meta":{}}')`);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});

afterEach(() => {
  if (savedStore === undefined) delete process.env["CODESIFT_NATIVE_STORE"];
  else process.env["CODESIFT_NATIVE_STORE"] = savedStore;
  resetNativeForTesting();
});

afterAll(() => {
  closeAllIndexDbs();
  rmSync(dir, { recursive: true, force: true });
});

async function via(impl: "ts" | "native", q: SymbolQuery): Promise<CodeSymbol[]> {
  process.env["CODESIFT_NATIVE_STORE"] = impl === "ts" ? "0" : "1";
  return findSymbolsSqlite(dbPath, q);
}

const many = SYMBOLS.slice(-1500).map((s) => s.id);
const QUERIES: Array<[string, SymbolQuery]> = [
  ["everything", { withSource: false }],
  ["everything + source", { withSource: true }],
  ["file", { withSource: true, file: "b.ts" }],
  ["name", { withSource: false, name: "createUser" }],
  ["unicode name", { withSource: true, name: "zażółć" }],
  ["prefix", { withSource: false, namePrefix: "create" }],
  ["prefix with _", { withSource: false, namePrefix: "a_" }],
  ["prefix with %", { withSource: false, namePrefix: "a%" }],
  ["kind", { withSource: false, kind: "class" }],
  ["parent", { withSource: true, parent: "t:b.ts:UserModel:3" }],
  ["ids incl. collision and unknown", { withSource: true, ids: ["t:a.ts:createUser:1", "nope", "t:d.ts:odd:1"] }],
  ["ids across chunks", { withSource: false, ids: many }],
  ["ids across chunks + limit", { withSource: false, ids: many, limit: 950 }],
  ["empty ids", { withSource: false, ids: [] }],
  ["limit 0", { withSource: false, limit: 0 }],
  ["limit 3", { withSource: false, kind: "function", limit: 3 }],
  ["combined", { withSource: false, file: "gen.ts", kind: "class", namePrefix: "n1" }],
  ["no match", { withSource: true, name: "does-not-exist" }],
  // Scan predicates (stage 6) — the Rust SQL must answer exactly as the TypeScript SQL.
  ["kinds", { withSource: false, kinds: ["class", "method"] }],
  ["empty kinds", { withSource: false, kinds: [] }],
  ["sourceContainsAny", { withSource: true, sourceContainsAny: ["createUser", "absent"] }],
  ["sourceContainsAny empty needle (every non-null source)", { withSource: false, sourceContainsAny: [""] }],
  ["empty sourceContainsAny", { withSource: false, sourceContainsAny: [] }],
  ["minLines", { withSource: false, minLines: 5 }],
  ["scan combo + limit", { withSource: true, kinds: ["function"], minLines: 1, sourceContainsAny: ["function"], limit: 1 }],
  ["kinds across id chunks", { withSource: false, ids: many, kinds: ["class"] }],
];

describe.skipIf(!native)("native store parity with the TypeScript read path", () => {
  it.each(QUERIES)("%s", async (_label, q) => {
    const ts = await via("ts", q);
    const rs = await via("native", q);
    expect(rs).toEqual(ts);
    // toEqual ignores key order and undefined-vs-absent; serialised tool output does not.
    expect(JSON.stringify(rs)).toBe(JSON.stringify(ts));
  });

  // Page sizes follow a time budget, so batch BOUNDARIES legitimately differ between runs; the
  // flattened sequence must not.
  it.each(QUERIES)("stream: %s", async (_label, q) => {
    const collect = async (impl: "ts" | "native") => {
      process.env["CODESIFT_NATIVE_STORE"] = impl === "ts" ? "0" : "1";
      const all: CodeSymbol[] = [];
      await streamSymbolsSqlite(dbPath, q, (batch) => {
        all.push(...batch);
      });
      return all;
    };
    const ts = await collect("ts");
    const rs = await collect("native");
    expect(JSON.stringify(rs)).toBe(JSON.stringify(ts));
  });

  it("stream: stops when the callback returns false, after the first batch", async () => {
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    let calls = 0;
    await streamSymbolsSqlite(dbPath, { withSource: false }, () => {
      calls++;
      return false;
    });
    expect(calls).toBe(1);
  });

  it("stream: a callback's own error reaches the caller unchanged", async () => {
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    const boom = new Error("callback failed");
    await expect(
      streamSymbolsSqlite(dbPath, { withSource: false }, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("keeps an unselected source ABSENT, not undefined", async () => {
    const [s] = await via("native", { withSource: false, name: "createUser" });
    expect(s).toBeDefined();
    expect("source" in s!).toBe(false);
  });

  it("answers getIndexMeta identically", async () => {
    process.env["CODESIFT_NATIVE_STORE"] = "0";
    const ts = await getIndexMetaSqlite(dbPath);
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    const rs = await getIndexMetaSqlite(dbPath);
    expect(rs).toEqual(ts);
    expect(rs).toMatchObject({ repo: "t", root: "/tmp/t", updatedAt: 4242, symbolCount: SYMBOLS.length + 1 });
  });

  it("answers an index with no repo key the same way: empty and null", async () => {
    const empty = join(dir, "empty.index.db");
    const db = new DatabaseSync(empty);
    db.exec(SCHEMA_SQL);
    db.close();
    process.env["CODESIFT_NATIVE_STORE"] = "1";
    expect(await findSymbolsSqlite(empty, { withSource: false })).toEqual([]);
    expect(await getIndexMetaSqlite(empty)).toBeNull();
  });
});

describe("rethrowNative", () => {
  it("classifies a tagged SQLite fault by its primary code, like the TypeScript driver's errcode", () => {
    // 261 = SQLITE_BUSY_RECOVERY; & 0xff = 5 = SQLITE_BUSY.
    try {
      rethrowNative(new Error("[sqlite:261] database is locked"), "/x.db");
    } catch (err) {
      expect(isIndexStorageError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("SQLITE_BUSY");
      return;
    }
    expect.fail("did not throw");
  });

  it("rethrows an unclassified failure unchanged, original error and all", () => {
    const original = new Error("[sqlite:1] no such table: symbols");
    expect(() => rethrowNative(original, "/x.db")).toThrow(original);
    const plain = new Error("malformed extras column: not a JSON object");
    expect(() => rethrowNative(plain, "/x.db")).toThrow(plain);
  });
});
