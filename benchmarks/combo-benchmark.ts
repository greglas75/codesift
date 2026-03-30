/**
 * COMBO benchmark: measures real-world tool combination patterns from usage data.
 *
 * Based on analysis of 3,427 calls across 188 sessions, this benchmark tests
 * the 7 most frequent tool combination patterns and compares them against
 * optimal single-call alternatives.
 *
 * Flow 1 (59×): search_symbols + search_text → get_context_bundle
 * Flow 2 (864 self-loops): search_text × 3 → codebase_retrieval batch
 * Flow 3 (153 ping-pong): codebase_retrieval + search_text × 2 → single CR high budget
 * Flow 4 (47×): get_file_tree + search_text → codebase_retrieval combined
 * Flow 5 (47×): search_patterns + search_text → search_patterns only
 * Flow 6 (85 self-loops): search_symbols × 3 → codebase_retrieval symbol batch
 * Flow 7 (111×): search_text → search_symbols → search_text → findAndShow
 *
 * Run: npx tsx benchmarks/combo-benchmark.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { searchSymbols, searchText } from "../src/tools/search-tools.js";
import { getContextBundle, findAndShow, formatSymbolCompact, formatBundleCompact } from "../src/tools/symbol-tools.js";
import { getFileTree } from "../src/tools/outline-tools.js";
import { searchPatterns } from "../src/tools/pattern-tools.js";
import { codebaseRetrieval } from "../src/retrieval/codebase-retrieval.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatSearchSymbols, formatSearchPatterns, formatFileTree } from "../src/formatters.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!.playwright-mcp --glob=!*.d.ts --glob=!generated";
const GREP_HEAD_LIMIT = 250;

function runRg(root: string, pattern: string, extra = ""): { output: string; ms: number; lines: number } {
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}' | head -${GREP_HEAD_LIMIT}`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

function runFind(root: string, pattern: string): { output: string; ms: number } {
  const cmd = `find '${root}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/.codesift/*' ${pattern} | head -200 | sort`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 15000 }); }
  catch { /* empty */ }
  return { output, ms: Math.round(performance.now() - start) };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComboRow {
  flow: string;
  query: string;
  repo: string;
  nativeTok: number;
  nativeMs: number;
  currentTok: number;
  optimalTok: number;
  currentMs: number;
  optimalMs: number;
  currentCalls: number;
  optimalCalls: number;
}

const FLOW_META: Record<string, { description: string; current: string; optimal: string; usageCount: number }> = {
  ss_then_st: {
    description: "search_symbols + search_text → get_context_bundle",
    current: "searchSymbols(top_k=1) + searchText(context_lines=3)",
    optimal: "getContextBundle (symbol + imports + siblings)",
    usageCount: 59,
  },
  st_x3_batch: {
    description: "search_text × 3 → codebase_retrieval batch",
    current: "3× sequential searchText(auto_group)",
    optimal: "1× codebaseRetrieval with 3 text queries",
    usageCount: 864,
  },
  cr_drilldown: {
    description: "codebase_retrieval + search_text × 2 → single CR high budget",
    current: "codebaseRetrieval(5K) + 2× searchText drill-down",
    optimal: "1× codebaseRetrieval(15K) with all 3 queries",
    usageCount: 153,
  },
  tree_then_st: {
    description: "get_file_tree + search_text → codebase_retrieval combined",
    current: "getFileTree(compact) + searchText(auto_group)",
    optimal: "1× codebaseRetrieval with file_tree + text",
    usageCount: 47,
  },
  patterns_then_st: {
    description: "search_patterns + search_text → search_patterns only",
    current: "searchPatterns + searchText(context_lines=3) (redundant)",
    optimal: "searchPatterns only (already includes context)",
    usageCount: 47,
  },
  ss_x3_batch: {
    description: "search_symbols × 3 → codebase_retrieval symbol batch",
    current: "3× sequential searchSymbols(top_k=3, include_source)",
    optimal: "1× codebaseRetrieval with 3 symbol queries",
    usageCount: 85,
  },
  st_ss_st_pingpong: {
    description: "search_text → search_symbols → search_text → findAndShow",
    current: "searchText + searchSymbols(top_k=1) + searchText(context=2)",
    optimal: "findAndShow(includeRefs=true)",
    usageCount: 111,
  },
};

// ---------------------------------------------------------------------------
// Query sets
// ---------------------------------------------------------------------------

const FLOW1_QUERIES = ["searchText", "getFileTree", "loadConfig", "buildBM25Index", "handleError", "validate", "parse", "create"];

const FLOW2_TRIPLES = [
  ["TODO", "FIXME", "HACK"],
  ["error", "catch", "throw"],
  ["async", "await", "Promise"],
  ["config", "env", "settings"],
  ["export", "default", "module"],
  ["create", "update", "delete"],
  ["import", "require", "from"],
  ["test", "describe", "expect"],
];

const FLOW3_TRIPLES = [
  ["searchSymbols", "BM25", "score"],
  ["codebaseRetrieval", "SubQuery", "tokenBudget"],
  ["getFileTree", "buildTree", "pathDepth"],
  ["loadConfig", "registryPath", "defaultTokenBudget"],
  ["findReferences", "wordBoundary", "ripgrep"],
  ["searchPatterns", "BUILTIN_PATTERNS", "PatternMatch"],
  ["getContextBundle", "extractImportLines", "siblings"],
  ["assembleContext", "estimateTokens", "truncated"],
];

const FLOW4_QUERIES = ["export", "import", "interface", "function", "class", "const", "async", "config"];

const FLOW5_PAIRS = [
  { pattern: "empty-catch", followUp: "catch" },
  { pattern: "console-log", followUp: "console.log" },
  { pattern: "any-type", followUp: ": any" },
  { pattern: "empty-catch", followUp: "try" },
  { pattern: "console-log", followUp: "console.warn" },
  { pattern: "any-type", followUp: "as any" },
];

const FLOW6_TRIPLES = [
  ["search", "index", "parse"],
  ["create", "update", "delete"],
  ["format", "validate", "transform"],
  ["load", "save", "cache"],
  ["handle", "process", "dispatch"],
  ["build", "compile", "bundle"],
  ["connect", "disconnect", "close"],
  ["encode", "decode", "compress"],
];

const FLOW7_PAIRS = [
  ["searchText", "BM25"],
  ["getFileTree", "buildTree"],
  ["loadConfig", "registryPath"],
  ["findReferences", "wordBoundary"],
  ["formatSymbolCompact", "CodeSymbol"],
  ["codebaseRetrieval", "SubQuery"],
  ["searchPatterns", "BUILTIN_PATTERNS"],
  ["getContextBundle", "extractImportLines"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printRow(query: string, row: ComboRow): void {
  console.log(
    `${query.padEnd(28)} ${String(row.nativeTok).padStart(8)} ${String(row.currentTok).padStart(8)} ${String(row.optimalTok).padStart(8)} ` +
    `${pct(row.optimalTok, row.nativeTok).padStart(9)} ${String(row.nativeMs).padStart(7)} ${String(row.currentMs).padStart(7)} ${String(row.optimalMs).padStart(7)}`
  );
}

function printTableHeader(): void {
  console.log(
    `${"query".padEnd(28)} ${"nat_tok".padStart(8)} ${"cur_tok".padStart(8)} ${"opt_tok".padStart(8)} ` +
    `${"nat→opt".padStart(9)} ${"nat_ms".padStart(7)} ${"cur_ms".padStart(7)} ${"opt_ms".padStart(7)}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: ComboRow[] = [];

  // Pre-warm indexes
  console.log("Pre-warming indexes...");
  for (const repo of REPOS) {
    await getCodeIndex(repo.id);
  }
  console.log("Indexes ready.\n");

  // ═══════════════════════════════════════════════════════
  // Flow 1: search_symbols + search_text → get_context_bundle
  // Usage: 59 transitions (24% of search_symbols)
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 1: search_symbols + search_text → get_context_bundle ═══");
  console.log("Usage data: 59 transitions. Current: 2 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const q of FLOW1_QUERIES) {
      // Native: Grep for function def + Grep for usages (what agent does with system tools)
      const natStart = performance.now();
      const grepDef = runRg(repo.root, `(export )?(async )?function ${q}`, "--glob=*.ts -A 20");
      const grepUsage = runRg(repo.root, q, "--glob=*.ts -C 3");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(grepDef.output) + tokStr(grepUsage.output);

      // Current: searchSymbols → searchText
      const curStart = performance.now();
      const symResults = await searchSymbols(repo.id, q, { top_k: 1, include_source: true });
      const textResults = await searchText(repo.id, q, { context_lines: 3, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = (symResults[0] ? tokStr(formatSearchSymbols(symResults)) : 0) + tokStr(textResults);

      // Optimal: getContextBundle
      const optStart = performance.now();
      const bundle = await getContextBundle(repo.id, q);
      const optMs = Math.round(performance.now() - optStart);
      if (!bundle) continue;
      const optTok = tokStr(formatBundleCompact(bundle));

      const row: ComboRow = { flow: "ss_then_st", query: q, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 2, optimalCalls: 1 };
      allRows.push(row);
      printRow(q, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 2: search_text × 3 → codebase_retrieval batch
  // Usage: 864 search_text self-loops
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 2: search_text × 3 → codebase_retrieval batch ═══");
  console.log("Usage data: 864 self-loops. Current: 3 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const [q1, q2, q3] of FLOW2_TRIPLES) {
      const label = `${q1}+${q2}+${q3}`;

      // Native: 3× sequential rg
      const natStart = performance.now();
      const g1 = runRg(repo.root, q1, "--glob=*.ts");
      const g2 = runRg(repo.root, q2, "--glob=*.ts");
      const g3 = runRg(repo.root, q3, "--glob=*.ts");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(g1.output) + tokStr(g2.output) + tokStr(g3.output);

      // Current: 3× sequential searchText
      const curStart = performance.now();
      const r1 = await searchText(repo.id, q1, { auto_group: true, compact: true });
      const r2 = await searchText(repo.id, q2, { auto_group: true, compact: true });
      const r3 = await searchText(repo.id, q3, { auto_group: true, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokStr(r1) + tokStr(r2) + tokStr(r3);

      // Optimal: 1× codebaseRetrieval batch
      const optStart = performance.now();
      const batch = await codebaseRetrieval(repo.id, [
        { type: "text", query: q1 },
        { type: "text", query: q2 },
        { type: "text", query: q3 },
      ], 10000);
      const optMs = Math.round(performance.now() - optStart);
      const optTok = tokJson(batch);

      const row: ComboRow = { flow: "st_x3_batch", query: label, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 3, optimalCalls: 1 };
      allRows.push(row);
      printRow(label, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 3: codebase_retrieval + search_text × 2 → single CR high budget
  // Usage: 153 ping-pong transitions
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 3: CR + search_text × 2 → single CR high budget ═══");
  console.log("Usage data: 153 transitions. Current: 3 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const [primary, drill1, drill2] of FLOW3_TRIPLES) {
      const label = `${primary}→${drill1},${drill2}`;

      // Native: 3× rg (initial + 2 drill-downs with context)
      const natStart = performance.now();
      const gPrimary = runRg(repo.root, primary, "--glob=*.ts");
      const gDrill1 = runRg(repo.root, drill1, "--glob=*.ts -C 2");
      const gDrill2 = runRg(repo.root, drill2, "--glob=*.ts -C 2");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(gPrimary.output) + tokStr(gDrill1.output) + tokStr(gDrill2.output);

      // Current: CR(5K) + 2× searchText drill-down
      const curStart = performance.now();
      const crResult = await codebaseRetrieval(repo.id, [
        { type: "text", query: primary },
      ], 5000);
      const drillR1 = await searchText(repo.id, drill1, { context_lines: 2, compact: true });
      const drillR2 = await searchText(repo.id, drill2, { context_lines: 2, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokJson(crResult) + tokStr(drillR1) + tokStr(drillR2);

      // Optimal: single CR with all 3 queries + higher budget
      const optStart = performance.now();
      const batchResult = await codebaseRetrieval(repo.id, [
        { type: "text", query: primary },
        { type: "text", query: drill1, context_lines: 2 },
        { type: "text", query: drill2, context_lines: 2 },
      ], 15000);
      const optMs = Math.round(performance.now() - optStart);
      const optTok = tokJson(batchResult);

      const row: ComboRow = { flow: "cr_drilldown", query: label, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 3, optimalCalls: 1 };
      allRows.push(row);
      printRow(label.slice(0, 28), row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 4: get_file_tree + search_text → codebase_retrieval combined
  // Usage: 47 transitions (26% of get_file_tree)
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 4: get_file_tree + search_text → CR combined ═══");
  console.log("Usage data: 47 transitions. Current: 2 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const q of FLOW4_QUERIES) {
      // Native: find (file tree) + rg (text search)
      const natStart = performance.now();
      const findResult = runFind(repo.root, "-name '*.ts' -o -name '*.tsx'");
      const grepResult = runRg(repo.root, q, "--glob=*.ts");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(findResult.output) + tokStr(grepResult.output);

      // Current: getFileTree + searchText
      const curStart = performance.now();
      const tree = await getFileTree(repo.id, { compact: true });
      const textResult = await searchText(repo.id, q, { auto_group: true, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokStr(formatFileTree(tree)) + tokStr(textResult);

      // Optimal: single codebaseRetrieval
      const optStart = performance.now();
      const batch = await codebaseRetrieval(repo.id, [
        { type: "file_tree", compact: true },
        { type: "text", query: q },
      ], 10000);
      const optMs = Math.round(performance.now() - optStart);
      const optTok = tokJson(batch);

      const row: ComboRow = { flow: "tree_then_st", query: q, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 2, optimalCalls: 1 };
      allRows.push(row);
      printRow(q, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 5: search_patterns + search_text → search_patterns only
  // Usage: 47 transitions (39% of search_patterns)
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 5: search_patterns + search_text → patterns only ═══");
  console.log("Usage data: 47 transitions. Current: 2 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const { pattern, followUp } of FLOW5_PAIRS) {
      const label = `${pattern}+${followUp}`;

      // Native: rg for pattern + rg for follow-up with context
      const PATTERN_REGEX: Record<string, string> = {
        "empty-catch": "catch\\s*\\{\\s*\\}",
        "console-log": "console\\.log\\(",
        "any-type": ": any[^A-Za-z]",
      };
      const natStart = performance.now();
      const gPat = runRg(repo.root, PATTERN_REGEX[pattern] ?? pattern, "--glob=*.ts");
      const gFollow = runRg(repo.root, followUp, "--glob=*.ts -C 3");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(gPat.output) + tokStr(gFollow.output);

      // Current: searchPatterns + redundant searchText
      const curStart = performance.now();
      const patResult = await searchPatterns(repo.id, pattern);
      const followUpResult = await searchText(repo.id, followUp, { context_lines: 3, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokStr(formatSearchPatterns(patResult)) + tokStr(followUpResult);

      // Optimal: searchPatterns alone (already includes context per match)
      const optStart = performance.now();
      const optResult = await searchPatterns(repo.id, pattern);
      const optMs = Math.round(performance.now() - optStart);
      const optTok = tokStr(formatSearchPatterns(optResult));

      const row: ComboRow = { flow: "patterns_then_st", query: label, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 2, optimalCalls: 1 };
      allRows.push(row);
      printRow(label, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 6: search_symbols × 3 → codebase_retrieval symbol batch
  // Usage: 85 search_symbols self-loops
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 6: search_symbols × 3 → CR symbol batch ═══");
  console.log("Usage data: 85 self-loops. Current: 3 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const [q1, q2, q3] of FLOW6_TRIPLES) {
      const label = `${q1}+${q2}+${q3}`;

      // Native: 3× rg for function definitions with context
      const natStart = performance.now();
      const g1 = runRg(repo.root, `(export )?(async )?function ${q1}[A-Z]`, "--glob=*.ts -A 20");
      const g2 = runRg(repo.root, `(export )?(async )?function ${q2}[A-Z]`, "--glob=*.ts -A 20");
      const g3 = runRg(repo.root, `(export )?(async )?function ${q3}[A-Z]`, "--glob=*.ts -A 20");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(g1.output) + tokStr(g2.output) + tokStr(g3.output);

      // Current: 3× sequential searchSymbols
      const curStart = performance.now();
      const s1 = await searchSymbols(repo.id, q1, { top_k: 3, include_source: true });
      const s2 = await searchSymbols(repo.id, q2, { top_k: 3, include_source: true });
      const s3 = await searchSymbols(repo.id, q3, { top_k: 3, include_source: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokStr(formatSearchSymbols(s1)) + tokStr(formatSearchSymbols(s2)) + tokStr(formatSearchSymbols(s3));

      // Optimal: 1× codebaseRetrieval symbol batch
      const optStart = performance.now();
      const batch = await codebaseRetrieval(repo.id, [
        { type: "symbols", query: q1, top_k: 3 },
        { type: "symbols", query: q2, top_k: 3 },
        { type: "symbols", query: q3, top_k: 3 },
      ], 10000);
      const optMs = Math.round(performance.now() - optStart);
      const optTok = tokJson(batch);

      const row: ComboRow = { flow: "ss_x3_batch", query: label, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 3, optimalCalls: 1 };
      allRows.push(row);
      printRow(label, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Flow 7: search_text → search_symbols → search_text → findAndShow
  // Usage: 111 transitions (52 ST→SS + 59 SS→ST)
  // ═══════════════════════════════════════════════════════
  console.log("═══ Flow 7: ST → SS → ST ping-pong → findAndShow ═══");
  console.log("Usage data: 111 transitions. Current: 3 calls | Optimal: 1 call\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    printTableHeader();

    for (const [symbolQuery, relatedQuery] of FLOW7_PAIRS) {
      const label = `${symbolQuery}→${relatedQuery}`;

      // Native: rg(text) + rg(function def) + rg(related with context)
      const natStart = performance.now();
      const gText = runRg(repo.root, symbolQuery, "--glob=*.ts");
      const gDef = runRg(repo.root, `(export )?(async )?function ${symbolQuery}`, "--glob=*.ts -A 20");
      const gRelated = runRg(repo.root, relatedQuery, "--glob=*.ts -C 2");
      const natMs = Math.round(performance.now() - natStart);
      const nativeTok = tokStr(gText.output) + tokStr(gDef.output) + tokStr(gRelated.output);

      // Current: searchText → searchSymbols → searchText
      const curStart = performance.now();
      const textR1 = await searchText(repo.id, symbolQuery, { compact: true });
      const symR = await searchSymbols(repo.id, symbolQuery, { top_k: 1, include_source: true });
      const textR2 = await searchText(repo.id, relatedQuery, { context_lines: 2, compact: true });
      const curMs = Math.round(performance.now() - curStart);
      const curTok = tokStr(textR1) + (symR[0] ? tokStr(formatSearchSymbols(symR)) : 0) + tokStr(textR2);

      // Optimal: findAndShow with refs
      const optStart = performance.now();
      const found = await findAndShow(repo.id, symbolQuery, true);
      const optMs = Math.round(performance.now() - optStart);
      if (!found) continue;
      const optTok = tokStr(formatSymbolCompact(found.symbol)) + (found.references ? tokStr(JSON.stringify(found.references.length)) : 0);

      const row: ComboRow = { flow: "st_ss_st_pingpong", query: label, repo: repo.label, nativeTok, nativeMs: natMs, currentTok: curTok, optimalTok: optTok, currentMs: curMs, optimalMs: optMs, currentCalls: 3, optimalCalls: 1 };
      allRows.push(row);
      printRow(label, row);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════
  // Summary — box table format
  // ═══════════════════════════════════════════════════════

  const flowIds = Object.keys(FLOW_META);
  const byFlow: Record<string, { natTok: number; curTok: number; optTok: number; natMs: number; curMs: number; optMs: number; optWins: number; curWins: number; ties: number; count: number; curCalls: number; optCalls: number }> = {};

  for (const fid of flowIds) {
    const rows = allRows.filter(r => r.flow === fid);
    if (rows.length === 0) continue;

    const natTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const curTok = rows.reduce((s, r) => s + r.currentTok, 0);
    const optTok = rows.reduce((s, r) => s + r.optimalTok, 0);
    const natMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const curMs = rows.reduce((s, r) => s + r.currentMs, 0);
    const optMs = rows.reduce((s, r) => s + r.optimalMs, 0);
    const curCalls = rows.reduce((s, r) => s + r.currentCalls, 0);
    const optCalls = rows.reduce((s, r) => s + r.optimalCalls, 0);
    const optWins = rows.filter(r => r.optimalTok < r.nativeTok).length;
    const curWins = rows.filter(r => r.nativeTok <= r.optimalTok).length;
    const ties = rows.filter(r => r.nativeTok === r.optimalTok).length;

    byFlow[fid] = { natTok, curTok, optTok, natMs, curMs, optMs, optWins, curWins, ties, count: rows.length, curCalls, optCalls };
  }

  // Format time as seconds string
  function fmtTime(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  // Format number with commas
  function fmtNum(n: number): string {
    return n.toLocaleString("en-US");
  }

  // Column widths
  const C = { combo: 38, runs: 4, natTok: 10, curTok: 10, optTok: 10, diff: 14, natTime: 8, curTime: 8, optTime: 8, wins: 5 };

  function hLine(left: string, mid: string, right: string): string {
    return `${left}${"─".repeat(C.combo + 2)}${mid}${"─".repeat(C.runs + 2)}${mid}${"─".repeat(C.natTok + 2)}${mid}${"─".repeat(C.curTok + 2)}${mid}${"─".repeat(C.optTok + 2)}${mid}${"─".repeat(C.diff + 2)}${mid}${"─".repeat(C.natTime + 2)}${mid}${"─".repeat(C.curTime + 2)}${mid}${"─".repeat(C.optTime + 2)}${mid}${"─".repeat(C.wins + 2)}${right}`;
  }

  function dataRow(combo: string, runs: string, natTok: string, curTok: string, optTok: string, diff: string, natTime: string, curTime: string, optTime: string, wins: string): string {
    return `│ ${combo.padEnd(C.combo)} │ ${runs.padStart(C.runs)} │ ${natTok.padStart(C.natTok)} │ ${curTok.padStart(C.curTok)} │ ${optTok.padStart(C.optTok)} │ ${diff.padStart(C.diff)} │ ${natTime.padStart(C.natTime)} │ ${curTime.padStart(C.curTime)} │ ${optTime.padStart(C.optTime)} │ ${wins.padStart(C.wins)} │`;
  }

  console.log("\n═══ SUMMARY ═══\n");
  console.log(hLine("┌", "┬", "┐"));
  console.log(dataRow("Kombinacja", "Runs", "Tok", "Tok Sift", "Tok Sift", "Token diff", "Czas", "Czas", "Czas", "Wins"));
  console.log(dataRow("", "", "natywne", "CURRENT", "OPTIMAL", "nat→cur→opt", "natywny", "Current", "Optimal", ""));
  console.log(hLine("├", "┼", "┤"));

  const shortNames: Record<string, string> = {
    ss_then_st: "search_symbols+search_text→bundle",
    st_x3_batch: "search_text×3→CR_batch",
    cr_drilldown: "CR+search_text×2→CR_high_bud",
    tree_then_st: "get_file_tree+search_text→CR",
    patterns_then_st: "search_patterns+search_text→pat",
    ss_x3_batch: "search_symbols×3→CR_sym_batch",
    st_ss_st_pingpong: "ST→SS→ST→findAndShow",
  };

  for (const fid of flowIds) {
    const f = byFlow[fid];
    if (!f) continue;

    // Token diff chain: native→current→optimal
    const natCurDiff = pct(f.curTok, f.natTok);
    const natOptDiff = pct(f.optTok, f.natTok);
    const diffStr = `${natCurDiff}→${natOptDiff}`;

    console.log(dataRow(
      shortNames[fid] ?? fid,
      String(f.count),
      fmtNum(f.natTok),
      fmtNum(f.curTok),
      fmtNum(f.optTok),
      diffStr,
      fmtTime(f.natMs),
      fmtTime(f.curMs),
      fmtTime(f.optMs),
      `${f.optWins}/${f.count}`,
    ));
  }

  console.log(hLine("├", "┼", "┤"));

  // Aggregate row
  const totNatTok = Object.values(byFlow).reduce((s, f) => s + f.natTok, 0);
  const totCurTok = Object.values(byFlow).reduce((s, f) => s + f.curTok, 0);
  const totOptTok = Object.values(byFlow).reduce((s, f) => s + f.optTok, 0);
  const totNatMs = Object.values(byFlow).reduce((s, f) => s + f.natMs, 0);
  const totCurMs = Object.values(byFlow).reduce((s, f) => s + f.curMs, 0);
  const totOptMs = Object.values(byFlow).reduce((s, f) => s + f.optMs, 0);
  const totCurCalls = Object.values(byFlow).reduce((s, f) => s + f.curCalls, 0);
  const totOptCalls = Object.values(byFlow).reduce((s, f) => s + f.optCalls, 0);
  const totOptWins = Object.values(byFlow).reduce((s, f) => s + f.optWins, 0);

  console.log(dataRow(
    `AGGREGATE (${totCurCalls}→${totOptCalls} calls)`,
    String(allRows.length),
    fmtNum(totNatTok),
    fmtNum(totCurTok),
    fmtNum(totOptTok),
    `${pct(totCurTok, totNatTok)}→${pct(totOptTok, totNatTok)}`,
    fmtTime(totNatMs),
    fmtTime(totCurMs),
    fmtTime(totOptMs),
    `${totOptWins}/${allRows.length}`,
  ));
  console.log(hLine("└", "┴", "┘"));

  // ═══════════════════════════════════════════════════════
  // Save JSON
  // ═══════════════════════════════════════════════════════
  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `combo-${stamp}.json`);

  const summary = {
    byFlow: Object.fromEntries(Object.entries(byFlow).map(([fid, f]) => [fid, {
      description: FLOW_META[fid]!.description,
      usageCount: FLOW_META[fid]!.usageCount,
      nativeTokTotal: f.natTok,
      currentTokTotal: f.curTok,
      optimalTokTotal: f.optTok,
      natToOptDiff: pct(f.optTok, f.natTok),
      nativeMsTotal: f.natMs,
      currentMsTotal: f.curMs,
      optimalMsTotal: f.optMs,
      currentCallsTotal: f.curCalls,
      optimalCallsTotal: f.optCalls,
      optimalWins: f.optWins,
      totalRuns: f.count,
    }])),
    aggregate: {
      totalNativeTok: totNatTok,
      totalCurrentTok: totCurTok,
      totalOptimalTok: totOptTok,
      natToOptSavings: pct(totOptTok, totNatTok),
      totalNativeMs: totNatMs,
      totalCurrentMs: totCurMs,
      totalOptimalMs: totOptMs,
      totalCurrentCalls: totCurCalls,
      totalOptimalCalls: totOptCalls,
      optimalWins: totOptWins,
      totalRuns: allRows.length,
    },
  };

  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), usageDataNote: "Based on 3,427 calls across 188 sessions (2026-03-24 to 2026-03-30)", rows: allRows, summary }, null, 2));
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
