/**
 * Benchmark: assemble_context vs multi-Read, find_and_show vs Grep+Read, detect_communities (unique)
 *
 * Run: npx tsx benchmarks/assemble-findshow-communities-benchmark.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { findAndShow, formatSymbolCompact, formatRefsCompact } from "../src/tools/symbol-tools.js";
import { assembleContext, getKnowledgeMap } from "../src/tools/context-tools.js";
import { detectCommunities } from "../src/tools/community-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatAssembleContext, formatCommunities } from "../src/formatters.js";

type RepoDef = { id: string; root: string; label: string };

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const RG_EXCLUDES = "--glob=!node_modules --glob=!.git --glob=!.next --glob=!dist --glob=!.codesift --glob=!coverage --glob=!.playwright-mcp --glob=!*.d.ts --glob=!generated";
const GREP_HEAD_LIMIT = 250;

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "0%" : "n/a";
  const d = Math.round(((current - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

function runRg(root: string, pattern: string, extra = ""): { output: string; ms: number; lines: number } {
  const cmd = `rg --no-heading -n ${extra} ${RG_EXCLUDES} -- '${pattern.replace(/'/g, "'\\''")}' '${root}' | head -${GREP_HEAD_LIMIT}`;
  const start = performance.now();
  let output = "";
  try { output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000, shell: "/bin/sh" }); }
  catch (err: unknown) { if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? ""); }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

interface Row { flow: string; query: string; repo: string; nativeTok: number; siftTok: number; nativeMs: number; siftMs: number }

async function main(): Promise<void> {
  const startedAt = new Date();
  const allRows: Row[] = [];

  // Pre-warm
  for (const repo of REPOS) await getCodeIndex(repo.id);

  // ═══════════════════════════════════════════════
  // Flow 1: assemble_context vs multi-file Read
  // "I need to understand how auth/search/payment works"
  // Native: Grep(topic) → parse files → Read top 5 files
  // Sift:   assemble_context(topic, level="L1")
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 1: assemble_context vs Grep + multi-Read ═══");
  console.log("Native: Grep(topic) → Read top 5 files  |  Sift: assemble_context(L1)\n");

  const contextQueries = ["search implementation", "error handling", "configuration", "file parsing", "index management"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of contextQueries) {
      // Native: grep for topic, read top 5 unique files
      const nativeStart = performance.now();
      const grepResult = runRg(repo.root, q.split(" ")[0]!, "--glob=*.ts --glob=*.tsx -l");
      const files = grepResult.output.split("\n").filter(Boolean).slice(0, 5);
      let nativeTok = tokStr(grepResult.output);
      for (const file of files) {
        try {
          const content = readFileSync(file, "utf-8");
          nativeTok += tokStr(content);
        } catch { /* */ }
      }
      const nativeMs = Math.round(performance.now() - nativeStart);

      // Sift: assemble_context L1 (signatures only — 3x denser)
      const siftStart = performance.now();
      const result = await assembleContext(repo.id, q, 5000, "L1");
      const siftMs = Math.round(performance.now() - siftStart);
      const siftTok = tokStr(formatAssembleContext(result as never));

      allRows.push({ flow: "assemble_context", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 2: find_and_show vs Grep + Read
  // "Show me processPayment with references"
  // Native: Grep(name -A20) + Grep(name -w) for refs
  // Sift:   find_and_show(name, include_refs=true)
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 2: find_and_show vs Grep(def) + Grep(refs) ═══");
  console.log("Native: Grep(X -A20) + Grep(X -w)  |  Sift: find_and_show(X, refs=true)\n");

  const findQueries = ["searchText", "buildBM25Index", "processPayment", "getFileTree", "loadConfig"];

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                      native_tok  sift_tok   diff  native_ms sift_ms");

    for (const q of findQueries) {
      // Native: grep definition + grep references
      const nativeStart = performance.now();
      const defGrep = runRg(repo.root, `function ${q}`, "--glob=*.ts --glob=*.tsx -A 20");
      const refGrep = runRg(repo.root, q, "-w --glob=*.ts --glob=*.tsx");
      const nativeMs = Math.round(performance.now() - nativeStart);
      const nativeTok = tokStr(defGrep.output) + tokStr(refGrep.output);

      // Sift: find_and_show with refs
      const siftStart = performance.now();
      const result = await findAndShow(repo.id, q, true);
      const siftMs = Math.round(performance.now() - siftStart);
      let siftTok = 0;
      if (result) {
        let text = formatSymbolCompact(result.symbol);
        if (result.references) {
          text += `\n\n--- references ---\n${formatRefsCompact(result.references)}`;
        }
        siftTok = tokStr(text);
      }

      allRows.push({ flow: "find_and_show", query: q, repo: repo.label, nativeTok, siftTok, nativeMs, siftMs });
      console.log(`${q.padEnd(25)} ${String(nativeTok).padStart(10)} ${String(siftTok).padStart(9)} ${pct(siftTok, nativeTok).padStart(6)} ${String(nativeMs).padStart(9)} ${String(siftMs).padStart(7)}`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Flow 3: detect_communities — UNIQUE (no native equivalent)
  // Measure: token output + time. Compare JSON vs text format potential.
  // ═══════════════════════════════════════════════
  console.log("═══ Flow 3: detect_communities (UNIQUE — no native equivalent) ═══");
  console.log("Measuring output size and time only\n");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);

    // Without focus
    const start1 = performance.now();
    const result1 = await detectCommunities(repo.id, "src");
    const ms1 = Math.round(performance.now() - start1);
    const tok1 = tokStr(formatCommunities(result1 as never));

    console.log(`  focus=src:     ${tok1} tok, ${ms1} ms`);

    // With narrow focus
    const start2 = performance.now();
    const result2 = await detectCommunities(repo.id, "src/tools");
    const ms2 = Math.round(performance.now() - start2);
    const tok2 = tokStr(formatCommunities(result2 as never));

    console.log(`  focus=src/tools: ${tok2} tok, ${ms2} ms`);

    allRows.push({ flow: "detect_communities", query: "focus=src", repo: repo.label, nativeTok: 0, siftTok: tok1, nativeMs: 0, siftMs: ms1 });
    allRows.push({ flow: "detect_communities", query: "focus=src/tools", repo: repo.label, nativeTok: 0, siftTok: tok2, nativeMs: 0, siftMs: ms2 });
    console.log();
  }

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════
  console.log("\n═══ SUMMARY ═══\n");
  for (const flow of ["assemble_context", "find_and_show", "detect_communities"]) {
    const rows = allRows.filter(r => r.flow === flow);
    if (rows.length === 0) continue;
    const nTok = rows.reduce((s, r) => s + r.nativeTok, 0);
    const sTok = rows.reduce((s, r) => s + r.siftTok, 0);
    const nMs = rows.reduce((s, r) => s + r.nativeMs, 0);
    const sMs = rows.reduce((s, r) => s + r.siftMs, 0);
    const sWins = rows.filter(r => r.siftTok < r.nativeTok).length;
    const nWins = rows.filter(r => r.nativeTok < r.siftTok && r.nativeTok > 0).length;

    console.log(`${flow}`);
    if (nTok > 0) {
      console.log(`  native: ${nTok} tok, ${nMs} ms`);
      console.log(`  sift:   ${sTok} tok, ${sMs} ms`);
      console.log(`  token diff: ${pct(sTok, nTok)}  speed diff: ${pct(sMs, nMs)}`);
      console.log(`  sift wins: ${sWins}/${rows.length}  native wins: ${nWins}/${rows.length}\n`);
    } else {
      console.log(`  sift:   ${sTok} tok, ${sMs} ms (UNIQUE — no native equivalent)\n`);
    }
  }

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `assemble-findshow-communities-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ startedAt: startedAt.toISOString(), rows: allRows }, null, 2));
  console.log(`saved: ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
