/**
 * `impact_analysis` parity on a REAL index (ADR-006 stage 7): the native walk (`nativeImpactFrom`, no
 * index in memory) against the TypeScript path (`impactFromIndex` over the loaded index and the
 * TypeScript adjacency), for several git ranges, depths and both `include_source` settings.
 *
 *   CODESIFT_NATIVE_STORE=1 node --max-old-space-size=12288 --import tsx \
 *     scripts/native-impact-parity.ts <repo> [<since> ...]       (default: HEAD~5 HEAD~30)
 *
 * The native store must be on: the graph reads the database through the core's SQLite, and so must the
 * index load, or two SQLite copies would share the file in one process.
 *
 * Exit 0 = identical, 1 = differences, 2 = usage / no graph.
 */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { getCodeIndex, getIndexSummary } from "../src/tools/index-tools.js";
import { buildAdjacencyIndex } from "../src/tools/graph-tools.js";
import { nativeGraphFor } from "../src/tools/graph-native.js";
import { impactFromIndex, nativeImpactFrom } from "../src/tools/impact-tools.js";

async function main(): Promise<void> {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: native-impact-parity.ts <repo> [<since> ...]");
    process.exit(2);
  }
  const ranges = process.argv.length > 3 ? process.argv.slice(3) : ["HEAD~5", "HEAD~30"];
  const summary = await getIndexSummary(repo, { skipFreshness: true });
  if (!summary) {
    console.error(`no index for ${repo}`);
    process.exit(2);
  }
  let t = performance.now();
  const graph = await nativeGraphFor(repo, false, false);
  if (!graph) {
    console.error("no native graph (is CODESIFT_NATIVE_STORE=1 set?)");
    process.exit(2);
  }
  console.log(`graph build: ${(performance.now() - t).toFixed(0)} ms, ${graph.nodeCount} nodes`);
  t = performance.now();
  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) process.exit(2);
  const adjacency = buildAdjacencyIndex(index.symbols, false, false);
  console.log(`TypeScript setup (index load + adjacency): ${(performance.now() - t).toFixed(0)} ms`);

  let diffs = 0;
  let cases = 0;
  for (const since of ranges) {
    const changed = execFileSync("git", ["diff", "--name-only", `${since}..HEAD`], { cwd: summary.root, encoding: "utf-8" })
      .split("\n").map((l) => l.trim()).filter(Boolean);
    for (const depth of [1, 2, 3]) {
      for (const withSource of [false, true]) {
        cases++;
        let t0 = performance.now();
        const ts = impactFromIndex(index, adjacency, changed, depth, withSource);
        const tsMs = performance.now() - t0;
        t0 = performance.now();
        const nat = await nativeImpactFrom(graph, changed, depth, withSource);
        const natMs = performance.now() - t0;
        const same = JSON.stringify(ts) === JSON.stringify(nat);
        if (!same) diffs++;
        console.log(
          `${since} (${changed.length} files) depth ${depth} source ${withSource}: ${same ? "same" : "DIFFERENT"} — ` +
            `${ts.affected_symbols.length} affected, ${ts.affected_tests.length} tests; walk ${tsMs.toFixed(0)} ms TS, ${natMs.toFixed(0)} ms native`,
        );
        if (!same) {
          console.log(`  ts:     ${JSON.stringify(ts).slice(0, 600)}`);
          console.log(`  native: ${JSON.stringify(nat).slice(0, 600)}`);
        }
      }
    }
  }
  console.log(diffs === 0 ? `ALL SAME (${cases} cases)` : `${diffs} of ${cases} DIFFERENT`);
  process.exit(diffs === 0 && cases > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
