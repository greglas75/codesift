// The two narrow reads behind the hot lookup tools (ADR-004 stage 2): symbols by requested id, and
// symbols in a set of files. Each replaced a filter over EVERY symbol, so the test that matters is
// not "does it find something" but "does it find exactly what the filter found, in the same order"
// — a narrow read that returns fewer rows reports success, and the tool built on it reports a fact.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findSymbols,
  findSymbolsByRequestedIds,
  findSymbolsInFiles,
  saveIndex,
} from "../../src/storage/index-store.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { resetIndexBackendForTesting } from "../../src/storage/index-migration.js";
import { filterByFiles, filterByRequestedIds } from "../../src/storage/narrow-filters.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

let dir: string;
let indexPath: string;
let prevBackend: string | undefined;

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "local/r", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}
const file = (path: string): FileEntry => ({ path, language: "typescript", symbol_count: 1, last_modified: 1 });
const indexOf = (symbols: CodeSymbol[], files: string[]): CodeIndex => ({
  repo: "local/r", root: "/tmp/r", files: files.map(file), symbols, created_at: 1, updated_at: 2,
});

beforeEach(() => {
  prevBackend = process.env["CODESIFT_INDEX_BACKEND"];
  dir = mkdtempSync(join(tmpdir(), "cs-narrow-"));
  indexPath = join(dir, "x.index.json");
});
afterEach(async () => {
  await closeAllIndexDbs();
  if (prevBackend === undefined) delete process.env["CODESIFT_INDEX_BACKEND"];
  else process.env["CODESIFT_INDEX_BACKEND"] = prevBackend;
  resetIndexBackendForTesting();
  rmSync(dir, { recursive: true, force: true });
});

async function underBackend<T>(backend: "json" | "sqlite", fn: () => Promise<T>): Promise<T> {
  process.env["CODESIFT_INDEX_BACKEND"] = backend;
  resetIndexBackendForTesting();
  return fn();
}

async function seedSqlite(index: CodeIndex): Promise<void> {
  await underBackend("sqlite", () => saveIndex(indexPath, index));
}

/** Order-sensitive, presence-of-source-sensitive, key-order-insensitive. */
const shape = (rows: CodeSymbol[]): string =>
  JSON.stringify(rows.map((r) => {
    const withFlag: Record<string, unknown> = { ...r, __hasSource: "source" in r };
    return Object.fromEntries(Object.keys(withFlag).sort().map((k) => [k, withFlag[k]]));
  }));

// Inserted deliberately out of id order, so "index order" and "id order" disagree and a result
// that came back in the planner's order rather than rowid order is visible.
const SYMBOLS: CodeSymbol[] = [
  sym({ id: "local/r:z.ts:zeta:9", name: "zeta", file: "z.ts", source: "function zeta() {}" }),
  sym({ id: "local/r:a.ts:alpha:1", name: "alpha", file: "a.ts", source: "function alpha() {}" }),
  // A real collision: TypeScript's type and value namespaces share a name and a line.
  sym({ id: "local/r:b.ts:Collide:3", name: "Collide", kind: "type", file: "b.ts" }),
  sym({ id: "local/r:b.ts:Collide:3", name: "Collide", kind: "constant", file: "b.ts" }),
  sym({ id: "local/r:m.ts:mid:4", name: "mid", file: "m.ts" }),
];

describe("findSymbolsByRequestedIds", () => {
  it("answers full ids, short ids and collisions exactly as the in-memory rule, in index order", async () => {
    await seedSqlite(indexOf(SYMBOLS, ["z.ts", "a.ts", "b.ts", "m.ts"]));
    const requests: string[][] = [
      ["local/r:a.ts:alpha:1"],
      ["a.ts:alpha:1"],
      ["b.ts:Collide:3"],
      ["m.ts:mid:4", "z.ts:zeta:9", "local/r:a.ts:alpha:1"],
      ["nope:1"],
      [],
      ["a.ts:alpha:1", "a.ts:alpha:1"],
    ];
    for (const ids of requests) {
      const got = await underBackend("sqlite", () => findSymbolsByRequestedIds(indexPath, ids, { withSource: false }));
      expect(shape(got), JSON.stringify(ids)).toBe(shape(filterByRequestedIds(SYMBOLS, ids, false)));
    }
    const collided = await underBackend("sqlite", () =>
      findSymbolsByRequestedIds(indexPath, ["b.ts:Collide:3"], { withSource: false }));
    expect(collided.map((s) => s.kind)).toEqual(["type", "constant"]);
  });

  it("still answers the short form when ids do NOT share one prefix (the fallback scan)", async () => {
    // Two prefixes: the MIN/MAX probe must notice and fall back instead of assuming `local/r:`.
    const mixed: CodeSymbol[] = [
      sym({ id: "local/r:a.ts:alpha:1", name: "alpha" }),
      sym({ id: "other/x:a.ts:alpha:1", name: "alpha" }),
      sym({ id: "bare-id-without-colon", name: "bare" }),
    ];
    await seedSqlite(indexOf(mixed, ["a.ts"]));
    for (const ids of [["a.ts:alpha:1"], ["bare-id-without-colon"], ["other/x:a.ts:alpha:1"]]) {
      const got = await underBackend("sqlite", () => findSymbolsByRequestedIds(indexPath, ids, { withSource: false }));
      expect(shape(got), JSON.stringify(ids)).toBe(shape(filterByRequestedIds(mixed, ids, false)));
    }
    const both = await underBackend("sqlite", () =>
      findSymbolsByRequestedIds(indexPath, ["a.ts:alpha:1"], { withSource: false }));
    expect(both).toHaveLength(2);
  });

  it("keeps global index order across the bound-parameter chunks", async () => {
    // 2,000 symbols, requested in reverse: chunks of 900 must not come back chunk-by-chunk.
    const many = Array.from({ length: 2000 }, (_, i) =>
      sym({ id: `local/r:f${i % 7}.ts:s${i}:${i}`, name: `s${i}`, file: `f${i % 7}.ts` }));
    await seedSqlite(indexOf(many, Array.from({ length: 7 }, (_, i) => `f${i}.ts`)));
    const ids = many.map((s) => s.id.slice("local/r:".length)).reverse();
    const got = await underBackend("sqlite", () => findSymbolsByRequestedIds(indexPath, ids, { withSource: false }));
    expect(got.map((s) => s.name)).toEqual(many.map((s) => s.name));
  });

  it("carries source only when asked, by omitting the key", async () => {
    await seedSqlite(indexOf(SYMBOLS, ["a.ts"]));
    const without = await underBackend("sqlite", () =>
      findSymbolsByRequestedIds(indexPath, ["a.ts:alpha:1"], { withSource: false }));
    const withSrc = await underBackend("sqlite", () =>
      findSymbolsByRequestedIds(indexPath, ["a.ts:alpha:1"], { withSource: true }));
    expect("source" in without[0]!).toBe(false);
    expect(withSrc[0]!.source).toBe("function alpha() {}");
  });

  it("answers identically on the JSON backend", async () => {
    const index = indexOf(SYMBOLS, ["z.ts", "a.ts", "b.ts", "m.ts"]);
    writeFileSync(indexPath, JSON.stringify(index));
    const ids = ["b.ts:Collide:3", "local/r:z.ts:zeta:9", "a.ts:alpha:1"];
    const fromJson = await underBackend("json", () => findSymbolsByRequestedIds(indexPath, ids, { withSource: true }));
    await seedSqlite(index);
    const fromSqlite = await underBackend("sqlite", () => findSymbolsByRequestedIds(indexPath, ids, { withSource: true }));
    expect(shape(fromSqlite)).toBe(shape(fromJson));
    expect(fromJson).toHaveLength(4);
  });
});

describe("findSymbolsInFiles", () => {
  it("returns every symbol of the requested files, in index order, on both backends", async () => {
    const index = indexOf(SYMBOLS, ["z.ts", "a.ts", "b.ts", "m.ts"]);
    writeFileSync(indexPath, JSON.stringify(index));
    const files = ["m.ts", "b.ts", "z.ts", "absent.ts"];
    const fromJson = await underBackend("json", () => findSymbolsInFiles(indexPath, files, { withSource: false }));
    await seedSqlite(index);
    const fromSqlite = await underBackend("sqlite", () => findSymbolsInFiles(indexPath, files, { withSource: false }));
    expect(shape(fromSqlite)).toBe(shape(fromJson));
    expect(shape(fromSqlite)).toBe(shape(filterByFiles(SYMBOLS, files, false)));
    expect(fromSqlite.map((s) => s.file)).toEqual(["z.ts", "b.ts", "b.ts", "m.ts"]);
  });

  it("does not lose files past the bound-parameter limit", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => sym({ id: `local/r:f${i}.ts:s:1`, name: "s", file: `f${i}.ts` }));
    await seedSqlite(indexOf(many, many.map((s) => s.file)));
    const files = many.map((s) => s.file).reverse();
    const got = await underBackend("sqlite", () => findSymbolsInFiles(indexPath, files, { withSource: false }));
    expect(got.map((s) => s.file)).toEqual(many.map((s) => s.file));
  });

  it("returns nothing for an empty file list rather than everything", async () => {
    await seedSqlite(indexOf(SYMBOLS, ["a.ts"]));
    expect(await underBackend("sqlite", () => findSymbolsInFiles(indexPath, [], { withSource: false }))).toEqual([]);
  });
});

describe("findSymbols ordering and prefix case", () => {
  it("returns rows in index order, so `limit` keeps choosing the same rows", async () => {
    // Without ORDER BY rowid a prefix query came back in NAME order through idx_symbols_name, and
    // `limit: 1` returned `createA` where every other path returned `createZ`.
    const rows = [
      sym({ id: "1", name: "createZ" }),
      sym({ id: "2", name: "createA" }),
      sym({ id: "3", name: "createM" }),
    ];
    const index = indexOf(rows, ["a.ts"]);
    writeFileSync(indexPath, JSON.stringify(index));
    const fromJson = await underBackend("json", () => findSymbols(indexPath, { withSource: false, namePrefix: "create", limit: 1 }));
    await seedSqlite(index);
    const fromSqlite = await underBackend("sqlite", () => findSymbols(indexPath, { withSource: false, namePrefix: "create", limit: 1 }));
    expect(fromSqlite.map((s) => s.name)).toEqual(["createZ"]);
    expect(shape(fromSqlite)).toBe(shape(fromJson));
  });

  it("matches a name prefix case-sensitively, like the JSON branch", async () => {
    // LIKE is case-insensitive in SQLite: `create%` used to return `CreateUser` on SQLite only.
    const rows = [sym({ id: "1", name: "createUser" }), sym({ id: "2", name: "CreateUser" })];
    const index = indexOf(rows, ["a.ts"]);
    writeFileSync(indexPath, JSON.stringify(index));
    const fromJson = await underBackend("json", () => findSymbols(indexPath, { withSource: false, namePrefix: "create" }));
    await seedSqlite(index);
    const fromSqlite = await underBackend("sqlite", () => findSymbols(indexPath, { withSource: false, namePrefix: "create" }));
    expect(fromSqlite.map((s) => s.name)).toEqual(["createUser"]);
    expect(shape(fromSqlite)).toBe(shape(fromJson));
  });

  it("treats GLOB metacharacters in a prefix as literals", async () => {
    const rows = [
      sym({ id: "1", name: "a*b" }), sym({ id: "2", name: "axb" }),
      sym({ id: "3", name: "q?z" }), sym({ id: "4", name: "qyz" }),
      sym({ id: "5", name: "[x]" }), sym({ id: "6", name: "x" }),
    ];
    await seedSqlite(indexOf(rows, ["a.ts"]));
    const names = async (namePrefix: string) =>
      (await underBackend("sqlite", () => findSymbols(indexPath, { withSource: false, namePrefix }))).map((s) => s.name);
    expect(await names("a*")).toEqual(["a*b"]);
    expect(await names("q?")).toEqual(["q?z"]);
    expect(await names("[x")).toEqual(["[x]"]);
  });
});
