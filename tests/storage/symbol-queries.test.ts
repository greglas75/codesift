// Narrow reads: ask the database for the rows a tool needs instead of materialising the index.
//
// A cold getCodeIndex builds 349 MB and ~352,000 objects for the largest repo here through a
// synchronous SQLite API. Measured against that: WHERE name = ? 9 ms, WHERE file = ? 10 ms,
// WHERE kind = ? 32 ms (after idx_symbols_kind). 31% of the 159 call sites need nothing more.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../../src/storage/sqlite/schema.js";
import { INSERT_SYMBOL_SQL, symbolToRow } from "../../src/storage/sqlite/rows.js";
import {
  findSymbolsSqlite, streamSymbolsSqlite, getIndexMetaSqlite,
} from "../../src/storage/sqlite/queries.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import type { CodeSymbol } from "../../src/types.js";

let dir: string;
let dbPath: string;

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}

function seed(symbols: CodeSymbol[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO meta (key,value) VALUES ('repo','t')").run();
    db.prepare("INSERT INTO meta (key,value) VALUES ('root','/tmp/t')").run();
    db.prepare("INSERT INTO meta (key,value) VALUES ('updated_at','4242')").run();
    db.exec("BEGIN");
    const stmt = db.prepare(INSERT_SYMBOL_SQL);
    for (const s of symbols) stmt.run(...(Object.values(symbolToRow(s)) as never[]));
    db.exec("COMMIT");
  } finally { db.close(); }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-q-")); dbPath = join(dir, "x.index.db"); });
afterEach(async () => { await closeAllIndexDbs(); rmSync(dir, { recursive: true, force: true }); });

describe("findSymbolsSqlite", () => {
  it("filters on each indexed predicate", async () => {
    seed([
      sym({ id: "1", name: "createUser", kind: "function", file: "a.ts" }),
      sym({ id: "2", name: "createInvoice", kind: "function", file: "b.ts" }),
      sym({ id: "3", name: "UserModel", kind: "class", file: "b.ts", parent: "mod" }),
    ]);
    const names = async (q: Parameters<typeof findSymbolsSqlite>[1]) =>
      (await findSymbolsSqlite(dbPath, q)).map((s) => s.name).sort();

    expect(await names({ withSource: false, file: "b.ts" })).toEqual(["UserModel", "createInvoice"]);
    expect(await names({ withSource: false, name: "createUser" })).toEqual(["createUser"]);
    expect(await names({ withSource: false, namePrefix: "create" })).toEqual(["createInvoice", "createUser"]);
    expect(await names({ withSource: false, kind: "class" })).toEqual(["UserModel"]);
    expect(await names({ withSource: false, parent: "mod" })).toEqual(["UserModel"]);
    expect(await names({ withSource: false, ids: ["1", "3"] })).toEqual(["UserModel", "createUser"]);
    expect(await names({ withSource: false, file: "b.ts", kind: "class" })).toEqual(["UserModel"]);
  });

  it("omits the source KEY when it was not asked for, rather than setting it undefined", async () => {
    // rowToSymbol tests `row.source !== null`, so a projected-away column would arrive as undefined
    // and produce a symbol indistinguishable from one whose source is genuinely empty. A caller
    // would read "this function has no body" as a fact about the code.
    seed([sym({ id: "1", name: "f", source: "function f() { return 1; }" })]);

    const without = (await findSymbolsSqlite(dbPath, { withSource: false, name: "f" }))[0]!;
    expect("source" in without).toBe(false);

    const withIt = (await findSymbolsSqlite(dbPath, { withSource: true, name: "f" }))[0]!;
    expect(withIt.source).toBe("function f() { return 1; }");
  });

  it("treats % and _ in a name prefix as literals, not wildcards", async () => {
    // Otherwise a symbol named `a_b` silently widens the query to everything matching `a?b`.
    seed([sym({ id: "1", name: "a_b" }), sym({ id: "2", name: "axb" })]);
    const got = await findSymbolsSqlite(dbPath, { withSource: false, namePrefix: "a_" });
    expect(got.map((s) => s.name)).toEqual(["a_b"]);
  });

  it("handles an id list longer than SQLite's parameter limit", async () => {
    // 999 binds is a hard error, not a slow query.
    const many = Array.from({ length: 1500 }, (_, i) => sym({ id: `s${i}`, name: `n${i}` }));
    seed(many);
    const ids = many.map((s) => s.id);
    const got = await findSymbolsSqlite(dbPath, { withSource: false, ids });
    expect(got).toHaveLength(1500);
  });

  it("honours limit across id chunks", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => sym({ id: `s${i}`, name: `n${i}` }));
    seed(many);
    const got = await findSymbolsSqlite(dbPath, { withSource: false, ids: many.map((s) => s.id), limit: 10 });
    expect(got).toHaveLength(10);
  });

  it("returns nothing for an empty id list rather than everything", async () => {
    // `ids: []` means "none of them". Falling through to an unfiltered query would return the whole
    // table — a filter that fails open is worse than one that throws.
    seed([sym({ id: "1", name: "a" }), sym({ id: "2", name: "b" })]);
    expect(await findSymbolsSqlite(dbPath, { withSource: false, ids: [] })).toEqual([]);
  });
});

describe("streamSymbolsSqlite", () => {
  it("visits every match across many pages, and never repeats one", async () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      sym({ id: `s${i}`, name: `n${i}`, kind: i % 100 === 0 ? "class" : "function" }));
    seed(many);

    const seen: string[] = [];
    await streamSymbolsSqlite(dbPath, { withSource: false, kind: "class" }, (batch) => {
      for (const s of batch) seen.push(s.id);
    });
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it("does not stop early on a sparse match spread across the table", async () => {
    // The trap this reader is written around: terminate on an EMPTY page, never on a short one.
    const many = Array.from({ length: 5000 }, (_, i) =>
      sym({ id: `s${i}`, name: `n${i}`, kind: i === 0 || i === 4999 ? "rare" : "function" }));
    seed(many);
    const seen: string[] = [];
    await streamSymbolsSqlite(dbPath, { withSource: false, kind: "rare" }, (b) => {
      for (const s of b) seen.push(s.id);
    });
    expect(seen.sort()).toEqual(["s0", "s4999"]);
  });

  it("stops at the limit without over-delivering", async () => {
    const many = Array.from({ length: 500 }, (_, i) => sym({ id: `s${i}`, name: `n${i}` }));
    seed(many);
    const seen: string[] = [];
    await streamSymbolsSqlite(dbPath, { withSource: false, limit: 7 }, (b) => {
      for (const s of b) seen.push(s.id);
    });
    expect(seen).toHaveLength(7);
  });

  it("yields between pages, so the daemon keeps answering during a full scan", async () => {
    const many = Array.from({ length: 2000 }, (_, i) => sym({ id: `s${i}`, name: `n${i}` }));
    seed(many);
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    await streamSymbolsSqlite(dbPath, { withSource: false }, () => {});
    clearTimeout(timer);
    expect(ticked).toBe(true);
  });
});

describe("getIndexMetaSqlite", () => {
  it("returns root, repo and counts without constructing a single symbol", async () => {
    seed([sym({ id: "1", name: "a" }), sym({ id: "2", name: "b", file: "b.ts" })]);
    const meta = await getIndexMetaSqlite(dbPath);
    expect(meta).toEqual({ repo: "t", root: "/tmp/t", updatedAt: 4242, symbolCount: 2, fileCount: 0 });
  });

  it("returns null for a database that has no index in it", async () => {
    const db = new DatabaseSync(dbPath); db.exec(SCHEMA_SQL); db.close();
    expect(await getIndexMetaSqlite(dbPath)).toBeNull();
  });
});
