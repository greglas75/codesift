// ADR-006 stage 7 — the Rust call graph against `buildAdjacencyIndex` on a REAL index.
//
//   node --max-old-space-size=12288 --import tsx scripts/native-graph-parity.ts <ts-copy.db> <native-copy.db> [core.node]
//
// Two byte-identical copies of one index.db: the TypeScript side reads the first through node:sqlite,
// the core the second through its own SQLite, so no file is ever open in two SQLite copies at once.
// Compares every id's callers and callees, in order, for the option sets the tools use, and reports
// build time and main-thread cost. Exit 1 on any difference.
import { createRequire } from "node:module";

const [tsDb, nativeDb, corePath] = process.argv.slice(2);
if (!tsDb || !nativeDb) {
  console.error("usage: native-graph-parity.ts <ts-copy.db> <native-copy.db> [core.node]");
  process.exit(2);
}
process.env["CODESIFT_NATIVE_STORE"] = "0";
const { loadIndexSqlite } = await import("../src/storage/sqlite/index-io.js");
const { buildAdjacencyIndex } = await import("../src/tools/graph-tools.js");
const { hashSymbolIds } = await import("../src/tools/graph-native.js");
const core = corePath
  ? createRequire(import.meta.url)(corePath)
  : (await import("../src/native/index.js")).getNativeCore("bm25");

const index = (await loadIndexSqlite(tsDb))!;
const symbols = index.symbols;
const uniqueIds = [...new Set(symbols.map((s) => s.id))];
let failures = 0;
for (const [skipTests, filterReactHooks] of [[true, false], [false, false], [true, true]] as const) {
  let t = performance.now();
  const ts = buildAdjacencyIndex(symbols, skipTests, filterReactHooks);
  const tsMs = performance.now() - t;
  t = performance.now();
  const pending = core.buildCallGraph(nativeDb, skipTests, filterReactHooks);
  const blockMs = performance.now() - t; // what the main thread paid to start it
  const graph = await pending;
  const nativeMs = performance.now() - t;
  const [a, b] = hashSymbolIds(symbols);
  const [ga, gb] = graph.idHash();
  if (graph.nodeCount !== symbols.length || a !== ga || b !== gb) {
    console.log(`node order differs: ${graph.nodeCount} nodes vs ${symbols.length} symbols`);
    failures++;
    continue;
  }
  let diffs = 0;
  const at = (p: Uint32Array | null) => (p === null ? null : Array.from(p, (i) => symbols[i]!.id).join("\n"));
  const ids = (l: { id: string }[] | undefined) => (l === undefined ? null : l.map((s) => s.id).join("\n"));
  for (const id of uniqueIds) {
    if (at(graph.callees(id)) !== ids(ts.callees.get(id))) diffs++;
    if (at(graph.callers(id)) !== ids(ts.callers.get(id))) diffs++;
  }
  failures += diffs;
  console.log(
    `skipTests=${skipTests} filterReactHooks=${filterReactHooks}: ${uniqueIds.length} ids, ${graph.edgeCount} edges, ` +
      `${diffs} differences — TS ${tsMs.toFixed(0)} ms on the main thread, Rust ${nativeMs.toFixed(0)} ms off it ` +
      `(${blockMs.toFixed(1)} ms to start), ${(graph.footprintBytes() / 1048576).toFixed(0)} MB in Rust`,
  );
}
process.exit(failures === 0 ? 0 : 1);
