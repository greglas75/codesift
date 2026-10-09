// ADR-006 stage 7, second half — the graph tools without an index in memory must answer exactly as
// the full-index path. Run twice against the same data dir and diff the output:
//
//   CODESIFT_DATA_DIR=<dir> CODESIFT_NATIVE_STORE=1 npx tsx scripts/native-graph-tools-parity.ts <repo> > native.txt
//   CODESIFT_DATA_DIR=<dir> CODESIFT_NATIVE_STORE=0 npx tsx scripts/native-graph-tools-parity.ts <repo> > ts.txt
//
// Separate processes, so each run has ONE SQLite copy on the index file.
const repo = process.argv[2]!;
const { traceCallChain, callNeighbours, classifySymbolRoles } = await import("../src/tools/graph-tools.js");
const { findRepoSymbols } = await import("../src/tools/index-tools.js");

const fns = await findRepoSymbols(repo, { withSource: false, kinds: ["function", "method"] });
const step = Math.max(1, Math.floor(fns.length / 40));
const picks = fns.filter((_, i) => i % step === 0).slice(0, 40);
const line = (label: string, value: unknown) => console.log(`${label}\t${JSON.stringify(value)}`);
const t0 = performance.now();
for (const sym of picks) {
  for (const direction of ["callers", "callees"] as const) {
    for (const include_tests of [false, true]) {
      try {
        line(`trace ${sym.name} ${direction} tests=${include_tests}`, await traceCallChain(repo, sym.name, direction, { depth: 2, include_tests }));
      } catch (e) {
        line(`trace ${sym.name} ${direction} tests=${include_tests}`, { error: (e as Error).message });
      }
    }
  }
}
line("neighbours", [...(await callNeighbours(repo, picks.map((s) => s.id), 8)).entries()]);
line("roles", await classifySymbolRoles(repo, { top_n: 200 }));
line("roles+tests", await classifySymbolRoles(repo, { include_tests: true, top_n: 200 }));
console.error(`${process.env["CODESIFT_NATIVE_STORE"] === "1" ? "native" : "ts"}: ${(performance.now() - t0).toFixed(0)} ms for ${picks.length} symbols`);
process.exit(0);
