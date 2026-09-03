// The same query must answer identically on both backends.
//
// SQLite is the fast path; JSON is what Node < 22.5 still runs, and there the predicate is a JS
// filter written by hand. Two hand-written predicates drift, and this one drifts DANGEROUSLY: a
// clause the JSON branch forgets does not throw, it returns MORE rows than were asked for. A filter
// that fails open is worse than one that fails.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSymbols, streamSymbols, getIndexMeta, saveIndex } from "../../src/storage/index-store.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { resetIndexBackendForTesting } from "../../src/storage/index-migration.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";
import type { SymbolQuery } from "../../src/storage/sqlite/queries.js";

let dir: string;
let indexPath: string;
let prevBackend: string | undefined;

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}

const SYMBOLS: CodeSymbol[] = [
  sym({ id: "1", name: "createUser", file: "a.ts", source: "function createUser() {}" }),
  sym({ id: "2", name: "createInvoice", file: "b.ts", kind: "function" }),
  sym({ id: "3", name: "UserModel", file: "b.ts", kind: "class", parent: "mod" }),
  sym({ id: "4", name: "a_b", file: "c.ts" }),
  sym({ id: "5", name: "axb", file: "c.ts" }),
];

const file = (path: string): FileEntry => ({
  path, language: "typescript", symbol_count: 1, last_modified: 1,
});

const INDEX: CodeIndex = {
  repo: "t", root: "/tmp/t", files: [file("a.ts"), file("b.ts"), file("c.ts")],
  symbols: SYMBOLS, created_at: 1, updated_at: 4242,
};

const QUERIES: SymbolQuery[] = [
  { withSource: false },
  { withSource: false, file: "b.ts" },
  { withSource: false, name: "createUser" },
  { withSource: false, namePrefix: "create" },
  { withSource: false, namePrefix: "a_" },
  { withSource: false, kind: "class" },
  { withSource: false, parent: "mod" },
  { withSource: false, ids: ["1", "3"] },
  { withSource: false, ids: [] },
  { withSource: false, limit: 2 },
  { withSource: true, name: "createUser" },
  { withSource: false, file: "b.ts", kind: "class" },
];

beforeEach(() => {
  prevBackend = process.env["CODESIFT_INDEX_BACKEND"];
  dir = mkdtempSync(join(tmpdir(), "cs-parity-"));
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

/**
 * Compare by CONTENT — same fields, same values, same presence-or-absence of `source`.
 *
 * Keys are sorted first because the two backends legitimately build them in different orders:
 * `rowToSymbol` assembles id-first, the JSON branch preserves whatever order the document had.
 * Key order is not part of any contract here and no caller can observe it, so an order-sensitive
 * comparison would fail on a non-difference and send the next reader looking for a bug.
 */
const shape = (rows: CodeSymbol[]): string =>
  JSON.stringify(
    rows
      .map((r) => {
        const withFlag: Record<string, unknown> = { ...r, __hasSource: "source" in r };
        return Object.fromEntries(Object.keys(withFlag).sort().map((k) => [k, withFlag[k]]));
      })
      .sort((a, b) => String(a["id"]).localeCompare(String(b["id"]))),
  );

describe("findSymbols backend parity", () => {
  it("answers every predicate the same on JSON and SQLite", async () => {
    writeFileSync(indexPath, JSON.stringify(INDEX));
    const fromJson: string[] = [];
    await underBackend("json", async () => {
      for (const q of QUERIES) fromJson.push(shape(await findSymbols(indexPath, q)));
    });

    await underBackend("sqlite", async () => { await saveIndex(indexPath, INDEX); });
    const fromSqlite: string[] = [];
    await underBackend("sqlite", async () => {
      for (const q of QUERIES) fromSqlite.push(shape(await findSymbols(indexPath, q)));
    });

    for (let i = 0; i < QUERIES.length; i++) {
      expect(fromSqlite[i], `query ${JSON.stringify(QUERIES[i])}`).toBe(fromJson[i]);
    }
  });

  it("omits the source key on both backends when it was not requested", async () => {
    // Setting it to undefined on one and omitting it on the other is a difference no caller can
    // see until it reads `symbol.source` and concludes the function has no body.
    writeFileSync(indexPath, JSON.stringify(INDEX));
    const j = await underBackend("json", () => findSymbols(indexPath, { withSource: false, name: "createUser" }));
    await underBackend("sqlite", async () => { await saveIndex(indexPath, INDEX); });
    const s = await underBackend("sqlite", () => findSymbols(indexPath, { withSource: false, name: "createUser" }));
    expect("source" in j[0]!).toBe(false);
    expect("source" in s[0]!).toBe(false);
  });

  it("streams the same rows it would have returned", async () => {
    writeFileSync(indexPath, JSON.stringify(INDEX));
    await underBackend("sqlite", async () => { await saveIndex(indexPath, INDEX); });
    for (const backend of ["json", "sqlite"] as const) {
      const streamed: CodeSymbol[] = [];
      await underBackend(backend, () =>
        streamSymbols(indexPath, { withSource: false, kind: "function" }, (b) => { streamed.push(...b); }));
      const listed = await underBackend(backend, () =>
        findSymbols(indexPath, { withSource: false, kind: "function" }));
      expect(shape(streamed), backend).toBe(shape(listed));
    }
  });

  it("reports the same metadata on both backends", async () => {
    writeFileSync(indexPath, JSON.stringify(INDEX));
    const j = await underBackend("json", () => getIndexMeta(indexPath));
    await underBackend("sqlite", async () => { await saveIndex(indexPath, INDEX); });
    const s = await underBackend("sqlite", () => getIndexMeta(indexPath));
    expect(s).toEqual(j);
  });
});
