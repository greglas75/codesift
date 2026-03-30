/**
 * Benchmark: get_file_tree vs Glob, search_patterns vs Grep, codebase_retrieval vs sequential
 *
 * Run: npx tsx benchmarks/next-three-benchmark.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getFileTree } from "../src/tools/outline-tools.js";
import { searchPatterns } from "../src/tools/pattern-tools.js";
import { codebaseRetrieval } from "../src/retrieval/codebase-retrieval.js";
import { searchText } from "../src/tools/search-tools.js";
import { searchSymbols } from "../src/tools/search-tools.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!.playwright-mcp --glob=!*.d.ts --glob=!generated";

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

function rg(root: string, pattern: string, extra = ""): { output: string; ms: number; lines: number } {
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}'`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

function glob(root: string, pattern: string): { output: string; ms: number; lines: number } {
  const cmd = `find '${root}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/.codesift/*' -not -path '*/coverage/*' ${pattern} | sort`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 }); }
  catch { /* empty */ }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

interface Row { tool: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number; nativeN: number; siftN: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  // ═══════════════════════════════════════════════════════
  // 1. get_file_tree vs find/glob
  // ═══════════════════════════════════════════════════════
  console.log("═══ get_file_tree vs find ═══\n");

  const treeQueries = [
    { id: "T1", label: "full repo", opts: { compact: true }, findArgs: "" },
    { id: "T2", label: "src/ only", opts: { compact: true, path_prefix: "src" }, findArgs: "-path '*/src/*'" },
    { id: "T3", label: "*.test.* files", opts: { compact: true, name_pattern: "*.test.*" }, findArgs: "-name '*.test.*'" },
    { id: "T4", label: "nested tree (default)", opts: {}, findArgs: "" },
    { id: "T5", label: "depth 2", opts: { compact: true, depth: 2 }, findArgs: "-maxdepth 4" },
  ];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                       find_tok  sift_tok   diff  find_ms sift_ms");
    for (const q of treeQueries) {
      const native = glob(repo.root, q.findArgs);
      const start = performance.now();
      const result = await getFileTree(repo.id, q.opts);
      const siftMs = Math.round(performance.now() - start);
      const nativeTok = tokStr(native.output);
      const siftTok = tokJson(result);
      const siftN = Array.isArray(result) ? result.length : ("entries" in (result as object) ? (result as { entries: unknown[] }).entries.length : 0);
      allRows.push({ tool: "get_file_tree", query: q.label, repo: repo.label, nativeTok, siftTok, nativeMs: native.ms, siftMs, nativeN: native.lines, siftN });
      console.log(`${(q.id + " " + q.label).padEnd(26)} ${String(nativeTok).padStart(8)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(native.ms).padStart(7)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // 2. search_patterns vs grep regex
  // ═══════════════════════════════════════════════════════
  console.log("═══ search_patterns vs rg ═══\n");

  const patternQueries = [
    { id: "P1", pattern: "empty-catch", rgPattern: "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}", label: "empty-catch" },
    { id: "P2", pattern: "console-log", rgPattern: "console\\.(log|debug|info)\\s*\\(", label: "console-log" },
    { id: "P3", pattern: "any-type", rgPattern: ":\\s*any\\b|as\\s+any\\b", label: "any-type" },
    { id: "P4", pattern: "scaffolding", rgPattern: "TODO|FIXME|HACK|XXX", label: "scaffolding" },
    { id: "P5", pattern: "unbounded-findmany", rgPattern: "findMany\\s*\\(", label: "unbounded-findmany" },
  ];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                         rg_tok  sift_tok   diff    rg_ms sift_ms  rg_n sift_n");
    for (const q of patternQueries) {
      const native = rg(repo.root, q.rgPattern, "--glob=*.ts --glob=*.tsx");
      const start = performance.now();
      const result = await searchPatterns(repo.id, q.pattern);
      const siftMs = Math.round(performance.now() - start);
      const nativeTok = tokStr(native.output);
      const siftTok = tokJson(result);
      allRows.push({ tool: "search_patterns", query: q.label, repo: repo.label, nativeTok, siftTok, nativeMs: native.ms, siftMs, nativeN: native.lines, siftN: result.matches.length });
      console.log(`${(q.id + " " + q.label).padEnd(28)} ${String(nativeTok).padStart(8)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(native.ms).padStart(8)} ${String(siftMs).padStart(7)} ${String(native.lines).padStart(5)} ${String(result.matches.length).padStart(5)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // 3. codebase_retrieval (batch) vs sequential calls
  // ═══════════════════════════════════════════════════════
  console.log("═══ codebase_retrieval (batch) vs sequential ═══\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    // Sequential: 3 separate calls
    const seqStart = performance.now();
    const r1 = await searchText(repo.id, "TODO", { file_pattern: "*.ts", auto_group: true });
    const r2 = await searchSymbols(repo.id, "create", { kind: "function", include_source: true });
    const r3 = await searchText(repo.id, "console.log", { auto_group: true });
    const seqMs = Math.round(performance.now() - seqStart);
    const seqTok = tokJson(r1) + tokJson(r2) + tokJson(r3);

    // Batch: 1 codebase_retrieval call
    const batchStart = performance.now();
    const batchResult = await codebaseRetrieval(repo.id, [
      { type: "text", query: "TODO", file_pattern: "*.ts" },
      { type: "symbols", query: "create", kind: "function" },
      { type: "text", query: "console.log" },
    ], 10000);
    const batchMs = Math.round(performance.now() - batchStart);
    const batchTok = tokJson(batchResult);

    allRows.push({ tool: "codebase_retrieval", query: "3-query batch", repo: repo.label, nativeTok: seqTok, siftTok: batchTok, nativeMs: seqMs, siftMs: batchMs, nativeN: 3, siftN: 1 });
    console.log(`  sequential (3 calls): ${seqTok} tok, ${seqMs} ms`);
    console.log(`  batch (1 call):       ${batchTok} tok, ${batchMs} ms`);
    console.log(`  token diff: ${pct(batchTok, seqTok)}  speed diff: ${pct(batchMs, seqMs)}`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════
  const tools = ["get_file_tree", "search_patterns", "codebase_retrieval"];
  console.log("\n═══ SUMMARY ═══\n");
  for (const tool of tools) {
    const rows = allRows.filter(r => r.tool === tool);
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const sWins = rows.filter(r => r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok < r.siftTok).length;
    console.log(`${tool}`);
    console.log(`  native: ${nTok} tok, ${nMs} ms`);
    console.log(`  sift:   ${sTok} tok, ${sMs} ms`);
    console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
    console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}`);
    console.log();
  }

  // Save JSON
  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `next-three-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
