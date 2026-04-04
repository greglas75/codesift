/**
 * REAL FLOW benchmark: simulates complete agent workflows, not isolated tool calls.
 *
 * Flow 1 (get_symbol): "I want to see the code of X"
 *   Native:  Grep(X) → parse file:line → Read(file, offset, limit)
 *   Sift:    search_symbols(X, top_k=1) → get_symbol(id)
 *
 * Flow 2 (get_symbols batch): "I want to see 5 functions matching X"
 *   Native:  Grep(X) → parse 5 results → 5x Read(file, offset, limit)
 *   Sift:    search_symbols(X, top_k=5) → get_symbols(ids)
 *
 * Flow 3 (find_references): "Where is X used?"
 *   Native:  Grep(X, -w)
 *   Sift:    find_references(X)
 *
 * Flow 4 (get_context_bundle): "Show me X with its imports and siblings"
 *   Native:  Grep(X) → parse file → Read(entire file)
 *   Sift:    get_context_bundle(X)
 *
 * Run: npx tsx benchmarks/real-flow-benchmark.ts
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
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

const GREP_HEAD_LIMIT = 250; // Claude Code default head_limit

function runRg(root: string, pattern: string, extra = ""): { output: string; ms: number; lines: number } {
  // Simulate real agent behavior: rg piped through head -250
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}' | head -${GREP_HEAD_LIMIT}`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

interface Row { flow: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number }

const QUERIES = ["searchText", "create", "handleError", "validate", "config", "parse", "render", "export"];

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  // Pre-warm indexes
  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════════
  // Flow 1: "Show me the code of X"
  // Native: Grep(X, -A 20) → gets definition + context
  // Sift:   search_symbols(X, top_k=1) + get_symbol(id) → compact text
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: Show me the code of X ═══");
  console.log("Native: Grep(X -A20 --glob=*.ts)  |  Sift: search_symbols + get_symbol\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                  native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of QUERIES) {
      // Native flow: grep for function definition with context
      const nativeStart = performance.now();
      const grepResult = runRg(repo.root, `(export )?(async )?function ${q}`, "--glob=*.ts --glob=*.tsx -A 20");
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(grepResult.output);

      // Sift flow: search + get_symbol
      const siftStart = performance.now();
      const searchResult = await searchSymbols(repo.id, q, { top_k: 1, kind: "function", include_source: false, detail_level: "compact" });
      let siftOutput = "";
      if (searchResult[0]) {
        const symResult = await getSymbol(repo.id, searchResult[0].symbol.id);
        if (symResult) siftOutput = formatSymbolCompact(symResult.symbol);
      }
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = tokStr(siftOutput);

      allRows.push({ flow: "get_symbol", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(21)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 2: "Show me 5 functions matching X"
  // Native: Grep(X, -A 20) → all matches with context
  // Sift:   search_symbols(X, top_k=5) + get_symbols(ids)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: Show me 5 functions matching X ═══");
  console.log("Native: Grep(X -A20)  |  Sift: search_symbols + get_symbols\n");

  const batchQueries = ["create", "handle", "validate", "get", "parse"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                  native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of batchQueries) {
      // Native: grep for function definitions
      const nativeStart = performance.now();
      const grepResult = runRg(repo.root, `(export )?(async )?function ${q}[A-Z]`, "--glob=*.ts --glob=*.tsx -A 20");
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(grepResult.output);

      // Sift: search + batch get
      const siftStart = performance.now();
      const searchResult = await searchSymbols(repo.id, q, { top_k: 5, kind: "function", include_source: false, detail_level: "compact" });
      const ids = searchResult.map(r => r.symbol.id);
      let siftOutput = "";
      if (ids.length > 0) {
        const syms = await getSymbols(repo.id, ids);
        siftOutput = formatSymbolsCompact(syms);
      }
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = tokStr(siftOutput);

      allRows.push({ flow: "get_symbols", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(21)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 3: "Where is X used?"
  // Native: Grep(X, -w)
  // Sift:   find_references(X) → compact text
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: Where is X used? ═══");
  console.log("Native: Grep(X -w)  |  Sift: find_references → compact\n");

  const refQueries = ["searchText", "getCodeIndex", "loadConfig", "CodeSymbol", "TextMatch"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                  native_tok  sift_tok   diff  native_ms sift_ms  nat_n sift_n");

    for (const q of refQueries) {
      const native = runRg(repo.root, q, "-w --glob=*.ts --glob=*.tsx");

      const siftStart = performance.now();
      const siftResult = await findReferences(repo.id, q);
      const siftMs = Math.round(performance.now() - siftStart);
      const siftCompact = formatRefsCompact(siftResult);
      const siftTok = tokStr(siftCompact);
      const nativeTok = tokStr(native.output);

      allRows.push({ flow: "find_references", query: q, repo: repo.label, nativeTok, siftTok, nativeMs: native.ms, siftMs });
      console.log(`${q.padEnd(21)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(native.ms).padStart(9)} ${String(siftMs).padStart(7)} ${String(native.lines).padStart(6)} ${String(siftResult.length).padStart(5)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 4: "Show me X with imports and siblings"
  // Native: Grep(X) → parse file → Read(entire file)
  // Sift:   get_context_bundle(X) → compact text
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 4: Show me X with imports and siblings ═══");
  console.log("Native: Grep(X) + Read(file)  |  Sift: get_context_bundle → compact\n");

  const bundleQueries = ["searchText", "getFileTree", "buildBM25Index", "processPayment", "createRisk"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                  native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of bundleQueries) {
      // Sift first (to know which file to read for native)
      const siftStart = performance.now();
      const bundle = await getContextBundle(repo.id, q);
      const siftMs = Math.round(performance.now() - siftStart);
      if (!bundle) continue;
      const siftTok = tokStr(formatBundleCompact(bundle));

      // Native: grep + read whole file
      const nativeStart = performance.now();
      const grepResult = runRg(repo.root, q, "--glob=*.ts --glob=*.tsx -l");
      let fileContent = "";
      const firstFile = grepResult.output.split("\n")[0];
      if (firstFile) {
        try { fileContent = readFileSync(firstFile, "utf-8"); } catch { /* */ }
      }
      const nativeMs = Math.round(performance.now() - nativeStart);
      // Native total = grep output + file content
      const nativeTok = tokStr(grepResult.output) + tokStr(fileContent);

      allRows.push({ flow: "get_context_bundle", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(21)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["get_symbol", "get_symbols", "find_references", "get_context_bundle"]) {
    const rows = allRows.filter(r => r.flow === flow);
    if (rows.length === 0) continue;
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const sWins = rows.filter(r => r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok < r.siftTok).length;
    const ties = rows.filter(r => r.nativeTok === r.siftTok).length;
    console.log(`${flow}`);
    console.log(`  native: ${nTok} tok, ${nMs} ms`);
    console.log(`  sift:   ${sTok} tok, ${sMs} ms`);
    console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
    console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}  ties: ${ties}\n`);
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `real-flow-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
