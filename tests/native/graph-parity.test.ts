// ADR-006 stage 7: the Rust call graph must give `buildAdjacencyIndex`'s answer exactly — every id's
// callers and callees, in order, with the same "no entry" cases — or trace_call_chain, impact_analysis
// and trace_route would silently change what they report.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../../src/storage/sqlite/schema.js";
import { INSERT_SYMBOL_SQL, symbolToRow } from "../../src/storage/sqlite/rows.js";
import { buildAdjacencyIndex } from "../../src/tools/graph-tools.js";
import { adjacencyFromGraph, hashSymbolIds } from "../../src/tools/graph-native.js";
import { getNativeCore, resetNativeForTesting } from "../../src/native/index.js";
import type { CodeSymbol } from "../../src/types.js";

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

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "src/a.ts", start_line: 1, end_line: 5, ...over };
}

const SYMBOLS: CodeSymbol[] = [
  sym({ id: "t:src/a.ts:fetchUser:1", name: "fetchUser", source: "function fetchUser() { return loadRow(id) && helper(); }" }),
  sym({ id: "t:src/a.ts:loadRow:9", name: "loadRow", source: "function loadRow() { db.query(); fetchUser(); }" }),
  sym({ id: "t:src/a.ts:helper:20", name: "helper", source: "const helper = () => [1].map(x => x).filter(Boolean)" }),
  sym({ id: "t:src/a.ts:map:30", name: "map", source: "function map() {}" }),
  sym({ id: "t:src/b.ts:helper:1", name: "helper", kind: "method", file: "src/b.ts", source: "helper() { this.helper(); useState(); useCustom(); }" }),
  sym({ id: "t:src/b.ts:useCustom:9", name: "useCustom", kind: "hook", file: "src/b.ts", source: "function useCustom() { useState(0); useEffect(f); }" }),
  sym({ id: "t:src/b.ts:useState:20", name: "useState", file: "src/b.ts", source: "export function useState() {}" }),
  sym({ id: "t:src/c.tsx:Page:1", name: "Page", kind: "component", file: "src/c.tsx", source: "const Page = () => <Layout><Button onClick={fetchUser} /></Layout>" }),
  sym({ id: "t:src/c.tsx:Layout:9", name: "Layout", kind: "component", file: "src/c.tsx", source: "function Layout() { return Page(); }" }),
  sym({ id: "t:src/c.tsx:Button:20", name: "Button", kind: "component", file: "src/c.tsx", source: "" }),
  // id collision: two symbols, one id — the TS Maps key by id, so they share callers.
  sym({ id: "t:src/d.ts:twin:1", name: "twin", file: "src/d.ts", source: "function twin() { helper(); }" }),
  sym({ id: "t:src/d.ts:twin:1", name: "twin", kind: "variable", file: "src/d.ts", source: "const twin = loadRow()" }),
  sym({ id: "t:src/d.ts:callsTwin:5", name: "callsTwin", file: "src/d.ts", source: "function callsTwin() { twin(); twin(); }" }),
  // test files: dropped when skipTests
  sym({ id: "t:src/a.test.ts:spec:1", name: "spec", file: "src/a.test.ts", source: "it('x', () => { fetchUser(); loadRow(); })" }),
  sym({ id: "t:src/__tests__/h.ts:mockHelper:1", name: "mockHelper", file: "src/__tests__/h.ts", source: "function mockHelper() { helper(); }" }),
  // PHP: -> and :: are method calls, never caller edges
  sym({ id: "t:app/Svc.php:run:1", name: "run", kind: "method", file: "app/Svc.php", source: "function run() { $this->save(); Repo::find(); persist(); }" }),
  sym({ id: "t:app/Svc.php:persist:9", name: "persist", file: "app/Svc.php", source: "function persist() {}" }),
  sym({ id: "t:app/Svc.php:save:20", name: "save", kind: "method", file: "app/Svc.php", source: "function save() {}" }),
  // non-callable kinds and short names never become targets
  sym({ id: "t:src/e.ts:Cfg:1", name: "Cfg", kind: "interface", file: "src/e.ts", source: "interface Cfg {}" }),
  sym({ id: "t:src/e.ts:ab:2", name: "ab", file: "src/e.ts", source: "function ab() { Cfg(); }" }),
  sym({ id: "t:src/e.ts:noSource:3", name: "noSource", file: "src/e.ts" }),
  sym({ id: "t:src/e.ts:unicode:4", name: "unicode", file: "src/e.ts", source: "function unicode() { /* zażółć 中文 🚀 */ fetchUser﻿(); persist\u0085(); }" }),
  ...Array.from({ length: 300 }, (_, i) => sym({ id: `t:src/gen.ts:g${i}:${i}`, name: `gen${i}`, file: "src/gen.ts", start_line: i, source: `function gen${i}() { gen${(i * 7) % 300}(); helper(); }` })),
];

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-graph-parity-"));
  dbPath = join(dir, "x.index.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.exec("INSERT INTO meta (key,value) VALUES ('repo','t'),('root','/tmp/t')");
    db.exec("BEGIN");
    const stmt = db.prepare(INSERT_SYMBOL_SQL);
    for (const s of SYMBOLS) stmt.run(...(symbolToRow(s) as never[]));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ids = (list: CodeSymbol[] | undefined) => (list === undefined ? null : list.map((s) => s.id));
const at = (positions: Uint32Array | null) => (positions === null ? null : Array.from(positions, (i) => SYMBOLS[i]!.id));

describe.skipIf(!native)("native call graph matches buildAdjacencyIndex", () => {
  it.each([
    ["tests skipped", true, false],
    ["tests included", false, false],
    ["React hooks filtered", true, true],
  ])("%s", async (_label, skipTests, filterReactHooks) => {
    const ts = buildAdjacencyIndex(SYMBOLS, skipTests, filterReactHooks);
    const graph = await native!.buildCallGraph(dbPath, skipTests, filterReactHooks);
    for (const id of new Set(SYMBOLS.map((s) => s.id))) {
      expect(at(graph.callees(id)), `callees of ${id}`).toEqual(ids(ts.callees.get(id)));
      expect(at(graph.callers(id)), `callers of ${id}`).toEqual(ids(ts.callers.get(id)));
    }
    let tsEdges = 0;
    for (const list of ts.callees.values()) tsEdges += list.length;
    expect(graph.edgeCount).toBeGreaterThanOrEqual(tsEdges); // callee lists of colliding ids are overwritten in TS, edges still counted
  });

  // Bug it catches: a graph evicted and released while impact_analysis still walked it threw out of
  // `.get(id)` — the consumer must get the TypeScript adjacency's answer instead.
  it("answers from the TypeScript adjacency once the graph is released mid-use", async () => {
    const graph = await native!.buildCallGraph(dbPath, true, false);
    const adjacency = adjacencyFromGraph(graph, SYMBOLS, () => buildAdjacencyIndex(SYMBOLS, true, false));
    const id = "t:src/a.ts:fetchUser:1";
    const before = ids(adjacency.callers.get(id));
    graph.release();
    const ts = buildAdjacencyIndex(SYMBOLS, true, false);
    expect(ids(adjacency.callees.get(id))).toEqual(ids(ts.callees.get(id)));
    expect(before).toEqual(ids(ts.callers.get(id)));
  });

  it("hashes node ids the way graph-native.ts verifies them", async () => {
    const graph = await native!.buildCallGraph(dbPath, true, false);
    expect(graph.nodeCount).toBe(SYMBOLS.length);
    expect(graph.idHash()).toEqual(hashSymbolIds(SYMBOLS));
    expect(hashSymbolIds(SYMBOLS.slice(1))).not.toEqual(hashSymbolIds(SYMBOLS));
  });
});
