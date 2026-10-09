/**
 * Import-graph parity on a REAL index (ADR-006 stage 4), at two levels:
 *
 *   1. per file — every `.ts`/`.tsx` file's `extractTypeScriptImports` (web-tree-sitter) against the
 *      Rust batch extractor, compared after JSON.stringify (same edges, order, keys);
 *   2. whole graph — `collectImportEdges` with the native parser off and on: identical edge lists,
 *      and both timings (no edge cache: the summary carries no `indexPath`, so both runs are cold).
 *
 *   node --max-old-space-size=8192 --import tsx scripts/native-imports-parity.ts <copy of an index.db>
 *
 * Exit 0 = identical, 1 = differences (the first few are printed), 2 = usage / no native core.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { getNativeCore } from "../src/native/index.js";
import { initParser, parseFile } from "../src/parser/parser-manager.js";
import { loadIndexSummary } from "../src/storage/index-store.js";
import { collectImportEdges } from "../src/utils/import-graph/collect.js";
import { extractTypeScriptImportsBatch } from "../src/utils/import-graph/typescript-edge-collector.js";
import { extractTypeScriptImports } from "../src/utils/ts-imports.js";

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: native-imports-parity.ts <index.db>");
    process.exit(2);
  }
  if (!getNativeCore("parser")) {
    console.error("no native core");
    process.exit(2);
  }
  // The store takes the canonical `.index.json` name and derives the `.db` beside it.
  const summary = await loadIndexSummary(dbPath.replace(/\.db$/, ".json"));
  if (!summary) {
    console.error(`no index at ${dbPath}`);
    process.exit(2);
  }
  const index = { ...summary, indexPath: undefined };
  await initParser();

  // 1. per file
  const tsFiles = index.files.filter((f) => /\.tsx?$/.test(f.path));
  let compared = 0;
  let nativeNull = 0;
  let diffCount = 0;
  const diffs: string[] = [];
  for (let i = 0; i < tsFiles.length; i += 1024) {
    const batch: Array<{ path: string; source: string }> = [];
    for (const f of tsFiles.slice(i, i + 1024)) {
      const source = await readFile(join(index.root, f.path), "utf-8").catch(() => null);
      if (source !== null) batch.push({ path: f.path, source });
    }
    const native = await extractTypeScriptImportsBatch(batch);
    for (const { path, source } of batch) {
      const got = native.get(path);
      if (got === undefined) {
        nativeNull++;
        continue;
      }
      const tree = await parseFile(path, source);
      if (!tree) continue;
      compared++;
      const want = JSON.stringify(extractTypeScriptImports(tree));
      if (JSON.stringify(got) === want) continue;
      diffCount++;
      if (diffs.length < 5) {
        diffs.push(`${path}\n  ts:     ${want.slice(0, 400)}\n  native: ${JSON.stringify(got).slice(0, 400)}`);
      }
    }
  }
  console.log(`per file: ${compared} compared, ${nativeNull} left to TypeScript, ${diffCount} differences`);

  // 2. whole graph
  const run = async (mode: string) => {
    process.env["CODESIFT_NATIVE_PARSER"] = mode;
    const t = performance.now();
    const edges = await collectImportEdges(index);
    return { edges, ms: performance.now() - t };
  };
  const previous = process.env["CODESIFT_NATIVE_PARSER"];
  const ts = await run("0");
  const nat = await run("1");
  if (previous === undefined) delete process.env["CODESIFT_NATIVE_PARSER"];
  else process.env["CODESIFT_NATIVE_PARSER"] = previous;
  const same = JSON.stringify(ts.edges) === JSON.stringify(nat.edges);
  console.log(
    `graph: ${index.files.length} files, ${ts.edges.length} vs ${nat.edges.length} edges, ` +
      `${same ? "identical" : "DIFFERENT"} — TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`,
  );

  for (const d of diffs) console.log(d);
  // A run that compared nothing proves nothing — e.g. a core declining every file would otherwise
  // pass both checks, the graph one because every file then takes the TypeScript path.
  if (compared === 0) console.log("FAIL: no file was compared");
  process.exit(diffCount === 0 && same && compared > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
