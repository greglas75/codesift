/**
 * Benchmark: get_symbol/get_symbols vs Read, find_references vs Grep, get_context_bundle vs Read
 *
 * Run: npx tsx benchmarks/symbols-refs-bundle-benchmark.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { getSymbol, getSymbols, findReferences, getContextBundle, formatSymbolCompact, formatSymbolsCompact, formatRefsCompact, formatBundleCompact } from "../src/tools/symbol-tools.js";
import { searchSymbols } from "../src/tools/search-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";

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
  const cmd = `rg --no-heading -n -w ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}'`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

function readFile_(root: string, relPath: string): { content: string; ms: number; lines: number } {
  const start = performance.now();
  let content = "";
  try { content = readFileSync(path.join(root, relPath), "utf-8"); } catch { /* */ }
  return { content, ms: Math.round(performance.now() - start), lines: content.split("\n").length };
}

interface Row { tool: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  // Pre-warm indexes
  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════
  // 1. get_symbol vs Read (targeted lines)
  // ═══════════════════════════════════════════
  console.log("═══ get_symbol vs Read ═══\n");

  // Find real symbol IDs to test
  const symbolQueries = ["searchText", "create", "handleError", "validate", "config", "parse", "render", "export", "process", "format"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                       read_tok  sift_tok   diff  read_ms sift_ms");

    for (const q of symbolQueries) {
      // Find a real symbol
      const results = await searchSymbols(repo.id, q, { top_k: 1, include_source: false, detail_level: "compact" });
      if (results.length === 0) continue;

      const sym = results[0]!.symbol;
      const symbolId = sym.id;

      // Native: Read the specific lines
      const lineCount = (sym.end_line ?? sym.start_line) - sym.start_line + 1;
      const nativeStart = performance.now();
      const fileContent = readFile_(repo.root, sym.file);
      const lines = fileContent.content.split("\n").slice(sym.start_line - 1, sym.end_line ?? sym.start_line);
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeOutput = lines.join("\n");
      const nativeTok = tokStr(nativeOutput);

      // Sift: get_symbol → compact text (what MCP returns)
      const siftStart = performance.now();
      const siftResult = await getSymbol(repo.id, symbolId);
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = siftResult ? tokStr(formatSymbolCompact(siftResult.symbol)) : 0;

      allRows.push({ tool: "get_symbol", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(26)} ${String(nativeTok).padStart(8)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(7)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════
  // 2. get_symbols (batch) vs sequential Read
  // ═══════════════════════════════════════════
  console.log("═══ get_symbols (batch 5) vs 5x Read ═══\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    const results = await searchSymbols(repo.id, "function", { top_k: 5, include_source: false, detail_level: "compact" });
    const ids = results.map(r => r.symbol.id);
    if (ids.length === 0) { console.log("  (no symbols found)\n"); continue; }

    // Native: 5 sequential reads
    const nativeStart = performance.now();
    let nativeTok = 0;
    for (const r of results) {
      const file = readFile_(repo.root, r.symbol.file);
      const lines = file.content.split("\n").slice(r.symbol.start_line - 1, r.symbol.end_line ?? r.symbol.start_line);
      nativeTok += tokStr(lines.join("\n"));
    }
    const nativeMs = Math.round(performance.now() - nativeStart);

    // Sift: 1 batch call → compact text
    const siftStart = performance.now();
    const siftResult = await getSymbols(repo.id, ids);
    const siftMs = Math.round(performance.now() - siftStart);
    const siftTok = tokStr(formatSymbolsCompact(siftResult));

    allRows.push({ tool: "get_symbols", query: "batch-5", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
    console.log(`  5x Read: ${nativeTok} tok, ${nativeMs} ms`);
    console.log(`  batch:   ${siftTok} tok, ${siftMs} ms`);
    console.log(`  diff:    ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // ═══════════════════════════════════════════
  // 3. find_references vs rg (word boundary)
  // ═══════════════════════════════════════════
  console.log("═══ find_references vs rg ═══\n");

  const refQueries = ["searchText", "getCodeIndex", "loadConfig", "CodeSymbol", "TextMatch"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                         rg_tok  sift_tok   diff    rg_ms sift_ms  rg_n sift_n");

    for (const q of refQueries) {
      const native = rg(repo.root, q, "--glob=*.ts --glob=*.tsx");

      const siftStart = performance.now();
      const siftResult = await findReferences(repo.id, q);
      const siftMs = Math.round(performance.now() - siftStart);
      const siftCompact = formatRefsCompact(siftResult);
      const siftTok = tokStr(siftCompact);
      const nativeTok = tokStr(native.output);

      allRows.push({ tool: "find_references", query: q, repo: repo.label, nativeTok, siftTok, nativeMs: native.ms, siftMs });
      console.log(`${q.padEnd(28)} ${String(nativeTok).padStart(8)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(native.ms).padStart(8)} ${String(siftMs).padStart(7)} ${String(native.lines).padStart(5)} ${String(siftResult.length).padStart(5)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════
  // 4. get_context_bundle vs Read (whole file)
  // ═══════════════════════════════════════════
  console.log("═══ get_context_bundle vs Read (whole file) ═══\n");

  const bundleQueries = ["searchText", "getFileTree", "buildBM25Index", "processPayment", "createRisk"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                       read_tok  sift_tok   diff  read_ms sift_ms");

    for (const q of bundleQueries) {
      // Sift: get_context_bundle
      const siftStart = performance.now();
      const bundle = await getContextBundle(repo.id, q);
      const siftMs = Math.round(performance.now() - siftStart);

      if (!bundle) continue;

      const siftTok = tokStr(formatBundleCompact(bundle));

      // Native: Read the whole file
      const native = readFile_(repo.root, bundle.symbol.file as string);
      const nativeTok = tokStr(native.content);

      allRows.push({ tool: "get_context_bundle", query: q, repo: repo.label, nativeTok, siftTok, nativeMs: native.ms, siftMs });
      console.log(`${q.padEnd(26)} ${String(nativeTok).padStart(8)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(native.ms).padStart(7)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  console.log("\n═══ SUMMARY ═══\n");
  for (const tool of ["get_symbol", "get_symbols", "find_references", "get_context_bundle"]) {
    const rows = allRows.filter(r => r.tool === tool);
    if (rows.length === 0) continue;
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
    console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}\n`);
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `symbols-refs-bundle-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
