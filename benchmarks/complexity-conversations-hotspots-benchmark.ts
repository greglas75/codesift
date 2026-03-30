/**
 * Benchmark: analyze_complexity vs manual, search_conversations (unique), analyze_hotspots vs git log
 *
 * Run: npx tsx benchmarks/complexity-conversations-hotspots-benchmark.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { analyzeComplexity } from "../src/tools/complexity-tools.js";
import { analyzeHotspots } from "../src/tools/hotspot-tools.js";
import { searchConversations } from "../src/tools/conversation-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatComplexity, formatHotspots, formatConversations } from "../src/formatters.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const GREP_HEAD_LIMIT = 250;

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

interface Row { flow: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════════
  // Flow 1: analyze_complexity vs manual grep for complexity indicators
  // Native: grep for nested if/for/while/switch + wc -l per file → manual parsing
  // Sift: analyze_complexity(top_n=10)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: analyze_complexity vs grep for nesting ═══");
  console.log("Native: grep nested control flow + wc -l  |  Sift: analyze_complexity\n");

  const complexityScopes = [
    { label: "all", file_pattern: undefined },
    { label: "src/tools", file_pattern: "src/tools" },
    { label: "services", file_pattern: "service" },
  ];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("scope                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const scope of complexityScopes) {
      // Native: grep for complexity indicators (nested if/for/while) + function line counts
      const nativeStart = performance.now();
      const globArg = scope.file_pattern ? `--glob='*${scope.file_pattern}*'` : "--glob=*.ts --glob=*.tsx";
      let output = "";
      try {
        // Count functions with their nesting - agent would grep for these
        const cmd = `rg --no-heading -n ${globArg} --glob=!node_modules --glob=!.git --glob=!dist --glob=!.codesift --glob=!coverage --glob=!*.d.ts '(if|for|while|switch)\\s*\\(' '${repo.root}' | head -${GREP_HEAD_LIMIT}`;
        output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" });
      } catch (err: unknown) {
        if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? "");
      }
      // Agent would also need wc -l per file to estimate function sizes
      let wcOutput = "";
      try {
        const wcCmd = `find '${repo.root}' -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' ${scope.file_pattern ? `-path '*${scope.file_pattern}*'` : ""} -exec wc -l {} + 2>/dev/null | head -50`;
        wcOutput = execSync(wcCmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" });
      } catch { /* */ }
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(output) + tokStr(wcOutput);

      // Sift: analyze_complexity
      const siftStart = performance.now();
      const result = await analyzeComplexity(repo.id, {
        file_pattern: scope.file_pattern,
        top_n: 10,
      });
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = tokStr(formatComplexity(result as never));

      allRows.push({ flow: "analyze_complexity", query: scope.label, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${scope.label.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 2: search_conversations — UNIQUE (no native equivalent)
  // Agent cannot search JSONL conversation history with native tools
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: search_conversations (UNIQUE) ═══");
  console.log("No native equivalent — agent cannot search conversation history\n");

  const convQueries = ["benchmark optimization", "token reduction", "ripgrep backend", "BM25 search", "compact format"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      sift_tok  sift_ms");

    for (const q of convQueries) {
      const siftStart = performance.now();
      const result = await searchConversations(q, undefined, 5);
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = tokStr(formatConversations(result as never));

      allRows.push({ flow: "search_conversations", query: q, repo: repo.label, nativeTok: 0, siftTok, nativeMs: 0, siftMs });
      console.log(`${q.padEnd(25)} ${String(siftTok).padStart(8)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 3: analyze_hotspots vs git log --numstat
  // Native: git log --numstat → parse manually
  // Sift: analyze_hotspots(since_days=90)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: analyze_hotspots vs git log ═══");
  console.log("Native: git log --numstat | sort  |  Sift: analyze_hotspots\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    // Native: git log --numstat + manual aggregation
    const nativeStart = performance.now();
    let gitOutput = "";
    try {
      gitOutput = execSync(
        `cd '${repo.root}' && git log --numstat --since='90 days ago' --pretty=format:'' | awk '{print $3}' | sort | uniq -c | sort -rn | head -30`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" },
      );
    } catch { /* */ }
    const nativeMs = Math.round(performance.now() - nativeStart);
    const nativeTok = tokStr(gitOutput);

    // Sift
    const siftStart = performance.now();
    const result = await analyzeHotspots(repo.id, { since_days: 90, top_n: 30 });
    const siftMs = Math.round(performance.now() - siftStart);
    const siftTok = tokStr(formatHotspots(result as never));

    allRows.push({ flow: "analyze_hotspots", query: "90d", repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
    console.log(`  native: ${nativeTok} tok, ${nativeMs} ms`);
    console.log(`  sift:   ${siftTok} tok, ${siftMs} ms`);
    console.log(`  diff:   ${pct(siftTok, nativeTok)} tokens, ${pct(siftMs, nativeMs)} speed\n`);
  }

  // Summary
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["analyze_complexity", "search_conversations", "analyze_hotspots"]) {
    const rows = allRows.filter(r => r.flow === flow);
    if (rows.length === 0) continue;
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const sWins = rows.filter(r => r.nativeTok > 0 && r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok > 0 && r.nativeTok < r.siftTok).length;

    console.log(`${flow}`);
    if (nTok > 0) {
      console.log(`  native: ${nTok} tok, ${nMs} ms`);
      console.log(`  sift:   ${sTok} tok, ${sMs} ms`);
      console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
      console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}\n`);
    } else {
      console.log(`  sift: ${sTok} tok, ${sMs} ms (UNIQUE)\n`);
    }
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `complexity-conversations-hotspots-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
