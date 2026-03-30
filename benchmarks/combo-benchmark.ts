/**
 * Unified benchmark: top 13 tool sequences from usage data, native vs Sift.
 * Real queries from usage.jsonl — exact calls agents made in 188 sessions.
 *
 * Sequences discovered via n-gram analysis on deduplicated session tool chains:
 *   2-element: st→cr(82×), cr→st(81×), ss→st(64×), st→ss(57×), tree→st(50×)
 *   3-element: pat→st→pat(39×), st→pat→st(40×), st→cr→st(41×), st→ss→st(27×), st→tree→st(27×)
 *   4-element: pat→st→pat→st(37×), st→pat→st→pat(35×), cr→st→cr→st(12×)
 *
 * Run: npx tsx benchmarks/combo-benchmark.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { searchSymbols, searchText } from "../src/tools/search-tools.js";
import { getFileTree, getFileOutline } from "../src/tools/outline-tools.js";
import { searchPatterns } from "../src/tools/pattern-tools.js";
import { codebaseRetrieval } from "../src/retrieval/codebase-retrieval.js";
import { getCodeIndex, listAllRepos } from "../src/tools/index-tools.js";
import { formatSearchSymbols, formatSearchPatterns, formatFileTree, formatFileOutline } from "../src/formatters.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}
function fmtTime(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function fmtNum(n: number): string { return n.toLocaleString("en-US"); }

const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!.playwright-mcp --glob=!*.d.ts --glob=!generated";

function runRg(root: string, pattern: string, extra = ""): { output: string; ms: number } {
  const escaped = pattern.replace(/'/g, "'\\''");
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${escaped}' '${root}' | head -250`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start) };
}

function runFind(root: string, pattern: string): { output: string; ms: number } {
  const cmd = `find '${root}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/.codesift/*' ${pattern} | head -200 | sort`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 15000 }); }
  catch { /* empty */ }
  return { output, ms: Math.round(performance.now() - start) };
}

function readFileSafe(p: string): string {
  try { return readFileSync(p, "utf-8"); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Usage data
// ---------------------------------------------------------------------------

interface UsageEntry { ts: number; tool: string; repo: string; args_summary: Record<string, unknown>; session_id: string }

function loadUsageEntries(): UsageEntry[] {
  const raw = readFileSync(path.join(homedir(), ".codesift", "usage.jsonl"), "utf-8");
  const entries: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.tool && e.session_id) entries.push(e); } catch { /* skip */ }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Types & table
// ---------------------------------------------------------------------------

interface Row { category: string; task: string; repo: string; nativeTok: number; nativeMs: number; siftTok: number; siftMs: number }

const COL = { cat: 22, runs: 4, natTok: 10, siftTok: 10, diff: 8, natTime: 8, siftTime: 8, wins: 5 };

function hLine(l: string, m: string, r: string): string {
  return `${l}${"─".repeat(COL.cat+2)}${m}${"─".repeat(COL.runs+2)}${m}${"─".repeat(COL.natTok+2)}${m}${"─".repeat(COL.siftTok+2)}${m}${"─".repeat(COL.diff+2)}${m}${"─".repeat(COL.natTime+2)}${m}${"─".repeat(COL.siftTime+2)}${m}${"─".repeat(COL.wins+2)}${r}`;
}

function tblRow(cat: string, runs: string, natTok: string, siftTok: string, diff: string, natT: string, siftT: string, wins: string): string {
  return `│ ${cat.padEnd(COL.cat)} │ ${runs.padStart(COL.runs)} │ ${natTok.padStart(COL.natTok)} │ ${siftTok.padStart(COL.siftTok)} │ ${diff.padStart(COL.diff)} │ ${natT.padStart(COL.natTime)} │ ${siftT.padStart(COL.siftTime)} │ ${wins.padStart(COL.wins)} │`;
}

// ---------------------------------------------------------------------------
// Native & Sift call replay
// ---------------------------------------------------------------------------

const PAT_RX: Record<string, string> = { "empty-catch": "catch\\s*\\{", "console-log": "console\\.log\\(", "any-type": ": any[^A-Za-z]", "scaffolding": "TODO|FIXME|HACK", "unbounded-findmany": "findMany\\(" };

function runNativeCall(root: string, e: UsageEntry): { output: string; ms: number } {
  const q = (e.args_summary.query as string) ?? "";
  const fp = e.args_summary.file_pattern as string | undefined;
  switch (e.tool) {
    case "search_text":
      return runRg(root, q, `${fp ? `--glob=${fp} ` : ""}${e.args_summary.context_lines ? `-C ${e.args_summary.context_lines}` : ""}`);
    case "search_symbols":
      return runRg(root, q, `--glob=*.ts --glob=*.tsx -A 10${fp ? ` --glob=${fp}` : ""}`);
    case "codebase_retrieval":
      return runRg(root, q || "export", "--glob=*.ts --glob=*.tsx");
    case "search_patterns":
      return runRg(root, PAT_RX[q] ?? (q || "TODO"), "--glob=*.ts");
    case "get_file_tree":
      return runFind(root, "-name '*.ts' -o -name '*.tsx'");
    case "get_file_outline": {
      const fp2 = e.args_summary.file_path as string;
      const start = performance.now();
      const content = readFileSafe(path.join(root, fp2 || ""));
      return { output: content, ms: Math.round(performance.now() - start) };
    }
    default:
      return { output: "", ms: 0 };
  }
}

async function runSiftCall(e: UsageEntry): Promise<{ text: string; ms: number }> {
  const start = performance.now();
  let text = "";
  try {
    switch (e.tool) {
      case "search_text": {
        text = await searchText(e.repo, e.args_summary.query as string, { compact: true, file_pattern: e.args_summary.file_pattern as string | undefined, context_lines: e.args_summary.context_lines as number | undefined, regex: e.args_summary.regex as boolean | undefined });
        break;
      }
      case "search_symbols": {
        const r = await searchSymbols(e.repo, e.args_summary.query as string, { top_k: 5, include_source: true, file_pattern: e.args_summary.file_pattern as string | undefined });
        text = formatSearchSymbols(r);
        break;
      }
      case "codebase_retrieval": {
        const types = e.args_summary.query_types;
        const budget = (e.args_summary.token_budget as number) ?? 10000;
        const queryArr = Array.isArray(types) ? (types as string[]).map(t => ({ type: t, query: (e.args_summary.query as string) ?? "code" })) : [{ type: "text", query: "code" }];
        const r = await codebaseRetrieval(e.repo, queryArr, budget);
        text = JSON.stringify(r, null, 2);
        break;
      }
      case "search_patterns": {
        const q = e.args_summary.query as string | undefined;
        if (q) { const r = await searchPatterns(e.repo, q); text = formatSearchPatterns(r); }
        break;
      }
      case "get_file_tree": {
        const r = await getFileTree(e.repo, { compact: true, path_prefix: e.args_summary.path_prefix as string | undefined });
        text = formatFileTree(r);
        break;
      }
      case "get_file_outline": {
        const fp = e.args_summary.file_path as string;
        if (fp) { const r = await getFileOutline(e.repo, fp); text = formatFileOutline(r); }
        break;
      }
    }
  } catch { /* skip */ }
  return { text, ms: Math.round(performance.now() - start) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  console.log("Loading usage.jsonl...");
  const entries = loadUsageEntries();
  console.log(`  ${entries.length} entries loaded`);

  const sessions = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    if (!sessions.has(e.session_id)) sessions.set(e.session_id, []);
    sessions.get(e.session_id)!.push(e);
  }
  for (const calls of Array.from(sessions.values())) calls.sort((a, b) => a.ts - b.ts);

  const repoList = await listAllRepos({ compact: true }) as string[];
  const available = new Set(repoList);
  console.log(`  ${available.size} repos indexed`);

  const usedRepos = new Set<string>();
  for (const e of entries) if (e.repo && available.has(e.repo)) usedRepos.add(e.repo);
  console.log(`  Pre-warming ${usedRepos.size} repos...`);
  const warmStart = performance.now();
  for (const repo of Array.from(usedRepos)) await getCodeIndex(repo);
  console.log(`  Warmed in ${fmtTime(Math.round(performance.now() - warmStart))}\n`);

  const rootCache = new Map<string, string>();
  async function getRoot(repo: string): Promise<string | null> {
    if (rootCache.has(repo)) return rootCache.get(repo)!;
    const idx = await getCodeIndex(repo);
    const root = (idx as { root?: string })?.root;
    if (root) { rootCache.set(repo, root); return root; }
    return null;
  }

  // Deduplicate consecutive same-tool calls
  const SKIP = new Set(["list_repos", "usage_stats", "index_folder", "index_file", "index_conversations", "suggest_queries"]);
  function dedup(calls: UsageEntry[]): UsageEntry[] {
    const r = [calls[0]!];
    for (let i = 1; i < calls.length; i++) {
      if (calls[i]!.tool !== calls[i - 1]!.tool) r.push(calls[i]!);
    }
    return r;
  }

  // Extract all instances of a specific tool sequence from sessions
  function extractNgrams(pattern: string[]): UsageEntry[][] {
    const n = pattern.length;
    const instances: UsageEntry[][] = [];
    for (const rawCalls of Array.from(sessions.values())) {
      const calls = dedup(rawCalls).filter(c => !SKIP.has(c.tool));
      for (let i = 0; i <= calls.length - n; i++) {
        const slice = calls.slice(i, i + n);
        if (slice.every((c, j) => c.tool === pattern[j]) && slice[0]!.repo && available.has(slice[0]!.repo)) {
          instances.push(slice);
        }
      }
    }
    return instances;
  }

  // ---------------------------------------------------------------------------
  // The 13 sequences (top 5 bigrams, top 5 trigrams, top 3 4-grams)
  // ---------------------------------------------------------------------------

  const SEQUENCES: Array<{ name: string; pattern: string[] }> = [
    // 2-element
    { name: "st→cr", pattern: ["search_text", "codebase_retrieval"] },
    { name: "cr→st", pattern: ["codebase_retrieval", "search_text"] },
    { name: "ss→st", pattern: ["search_symbols", "search_text"] },
    { name: "st→ss", pattern: ["search_text", "search_symbols"] },
    { name: "tree→st", pattern: ["get_file_tree", "search_text"] },
    // 3-element
    { name: "pat→st→pat", pattern: ["search_patterns", "search_text", "search_patterns"] },
    { name: "st→pat→st", pattern: ["search_text", "search_patterns", "search_text"] },
    { name: "st→cr→st", pattern: ["search_text", "codebase_retrieval", "search_text"] },
    { name: "st→ss→st", pattern: ["search_text", "search_symbols", "search_text"] },
    { name: "st→tree→st", pattern: ["search_text", "get_file_tree", "search_text"] },
    // 4-element
    { name: "pat→st→pat→st", pattern: ["search_patterns", "search_text", "search_patterns", "search_text"] },
    { name: "st→pat→st→pat", pattern: ["search_text", "search_patterns", "search_text", "search_patterns"] },
    { name: "cr→st→cr→st", pattern: ["codebase_retrieval", "search_text", "codebase_retrieval", "search_text"] },
  ];

  for (const seq of SEQUENCES) {
    const instances = extractNgrams(seq.pattern);
    console.log(`═══ ${seq.pattern.join(" → ")} (${instances.length} instances) ═══`);

    for (const calls of instances) {
      const root = await getRoot(calls[0]!.repo);
      if (!root) continue;

      const repoShort = calls[0]!.repo.split("/")[1] ?? calls[0]!.repo;
      const label = calls.map(c => ((c.args_summary?.query as string) ?? "-").slice(0, 15)).join("→");

      // Native
      const natStart = performance.now();
      let natTok = 0;
      for (const c of calls) { natTok += tokStr(runNativeCall(root, c).output); }
      const natMs = Math.round(performance.now() - natStart);

      // Sift
      const siftStart = performance.now();
      let siftTok = 0;
      for (const c of calls) { siftTok += tokStr((await runSiftCall(c)).text); }
      const siftMs = Math.round(performance.now() - siftStart);

      const row: Row = { category: seq.name, task: label, repo: calls[0]!.repo, nativeTok: natTok, nativeMs: natMs, siftTok, siftMs };
      allRows.push(row);
      console.log(`  ${(repoShort + ":" + label).slice(0,55).padEnd(55)} ${String(natTok).padStart(7)} ${String(siftTok).padStart(7)} ${pct(siftTok, natTok).padStart(7)} ${String(natMs).padStart(6)} ${String(siftMs).padStart(6)}`);
    }
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const categories = Array.from(new Set(allRows.map(r => r.category)));
  const byCategory: Record<string, { natTok: number; siftTok: number; natMs: number; siftMs: number; wins: number; count: number }> = {};
  for (const cat of categories) {
    const rows = allRows.filter(r => r.category === cat);
    byCategory[cat] = {
      natTok: rows.reduce((s, r) => s + r.nativeTok, 0),
      siftTok: rows.reduce((s, r) => s + r.siftTok, 0),
      natMs: rows.reduce((s, r) => s + r.nativeMs, 0),
      siftMs: rows.reduce((s, r) => s + r.siftMs, 0),
      wins: rows.filter(r => r.siftTok < r.nativeTok).length,
      count: rows.length,
    };
  }

  console.log("═══ SUMMARY ═══\n");
  console.log(hLine("┌", "┬", "┐"));
  console.log(tblRow("Narzędzie", "Runs", "Tok", "Tok", "Token", "Czas", "Czas", "Wins"));
  console.log(tblRow("", "", "natywne", "Sift", "diff", "natywny", "Sift", ""));
  console.log(hLine("├", "┼", "┤"));
  for (const cat of categories) {
    const c = byCategory[cat]!;
    console.log(tblRow(cat, String(c.count), fmtNum(c.natTok), fmtNum(c.siftTok), pct(c.siftTok, c.natTok), fmtTime(c.natMs), fmtTime(c.siftMs), `${c.wins}/${c.count}`));
  }
  console.log(hLine("├", "┼", "┤"));
  const totNat = Object.values(byCategory).reduce((s, c) => s + c.natTok, 0);
  const totSift = Object.values(byCategory).reduce((s, c) => s + c.siftTok, 0);
  const totNatMs = Object.values(byCategory).reduce((s, c) => s + c.natMs, 0);
  const totSiftMs = Object.values(byCategory).reduce((s, c) => s + c.siftMs, 0);
  const totWins = Object.values(byCategory).reduce((s, c) => s + c.wins, 0);
  console.log(tblRow("AGGREGATE", String(allRows.length), fmtNum(totNat), fmtNum(totSift), pct(totSift, totNat), fmtTime(totNatMs), fmtTime(totSiftMs), `${totWins}/${allRows.length}`));
  console.log(hLine("└", "┴", "┘"));

  // Save
  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `combo-${stamp}.json`);
  const summary = {
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([cat, c]) => [cat, { ...c, tokenDiff: pct(c.siftTok, c.natTok) }])),
    aggregate: { totalNativeTok: totNat, totalSiftTok: totSift, tokenDiff: pct(totSift, totNat), totalNativeMs: totNatMs, totalSiftMs: totSiftMs, siftWins: totWins, totalRuns: allRows.length },
  };
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), note: "Top 13 tool sequences from n-gram analysis, real queries from usage.jsonl", rows: allRows, summary }, null, 2));
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
