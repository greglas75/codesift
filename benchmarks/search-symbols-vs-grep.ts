/**
 * search_symbols vs rg — Tool Output Token Benchmark
 *
 * search_symbols uses BM25 ranking + AST-aware symbol extraction.
 * rg equivalent: grep for function/class/type definitions with context.
 *
 * Run: npx tsx benchmarks/search-symbols-vs-grep.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { searchSymbols } from "../src/tools/search-tools.js";

type RepoDef = { id: string; root: string; label: string };
type QueryDef = {
  id: string;
  query: string;
  kind?: string;
  file_pattern?: string;
  rgPattern: string; // equivalent rg pattern
  rgFlags?: string;  // extra rg flags
};

interface ResultRow {
  repo: string;
  queryId: string;
  query: string;
  grepTokens: number;
  grepMs: number;
  grepLines: number;
  siftTokens: number;
  siftMs: number;
  siftItems: number;
  tokenDiffPct: number | null;
  speedDiffPct: number | null;
}

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

// Real queries based on usage data: search_symbols is used for finding functions, classes, types by name
const QUERIES: QueryDef[] = [
  // Find specific function
  { id: "S01", query: "searchText", kind: "function",
    rgPattern: "(export )?(async )?function searchText", rgFlags: "-A 5" },
  // Find all create* functions
  { id: "S02", query: "create", kind: "function",
    rgPattern: "(export )?(async )?function create[A-Z]", rgFlags: "-A 3" },
  // Find interface/type
  { id: "S03", query: "Config",  kind: "interface",
    rgPattern: "(export )?(interface|type) \\w*Config", rgFlags: "-A 10" },
  // Find class
  { id: "S04", query: "Service", kind: "class",
    rgPattern: "(export )?class \\w*Service", rgFlags: "-A 5" },
  // Broad search — all exports (no kind filter)
  { id: "S05", query: "handle",
    rgPattern: "(export )?(async )?function handle[A-Z]", rgFlags: "-A 3" },
  // Find hooks (React)
  { id: "S06", query: "use", kind: "function", file_pattern: "*.tsx",
    rgPattern: "(export )?(function|const) use[A-Z]", rgFlags: "" },
  // Find type definitions
  { id: "S07", query: "Props", kind: "type",
    rgPattern: "(export )?type \\w*Props", rgFlags: "-A 5" },
  // Find specific symbol with source
  { id: "S08", query: "processPayment", kind: "function",
    rgPattern: "(export )?(async )?function processPayment", rgFlags: "-A 20" },
  // Compact mode — just locations
  { id: "S09", query: "validate", kind: "function",
    rgPattern: "(export )?(async )?function validate[A-Z]", rgFlags: "" },
  // Wide search — all functions in a path
  { id: "S10", query: "export", file_pattern: "*.service.ts",
    rgPattern: "(export )?(async )?function ", rgFlags: "" },
];

const RG_EXCLUDES = [
  "--glob=!node_modules", "--glob=!.git", "--glob=!.next", "--glob=!dist",
  "--glob=!.codesift", "--glob=!coverage", "--glob=!.playwright-mcp",
  "--glob=!*.d.ts", "--glob=!generated",
];

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pctDiff(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return Math.round(((current - baseline) / baseline) * 100);
}

function runRg(root: string, q: QueryDef): { output: string; ms: number; lines: number } {
  const parts = ["rg", "--no-heading", "-n"];
  if (q.rgFlags) parts.push(...q.rgFlags.split(" ").filter(Boolean));
  if (q.file_pattern) parts.push(`--glob='${q.file_pattern}'`);
  else parts.push("--glob=*.ts", "--glob=*.tsx");
  parts.push(...RG_EXCLUDES, "--", `'${q.rgPattern}'`, `'${root}'`);

  const start = performance.now();
  let output = "";
  try {
    output = execSync(parts.join(" "), { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? "");
  }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

async function runSift(repoId: string, q: QueryDef): Promise<{ result: unknown; ms: number; items: number }> {
  const start = performance.now();
  const result = await searchSymbols(repoId, q.query, {
    kind: q.kind as "function" | "class" | "interface" | "type" | undefined,
    file_pattern: q.file_pattern,
    include_source: true,
    detail_level: "standard",
  });
  const ms = Math.round(performance.now() - start);
  return { result, ms, items: Array.isArray(result) ? result.length : 0 };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const rows: ResultRow[] = [];

  console.log("search_symbols vs rg");
  console.log(`date: ${startedAt.toISOString().slice(0, 10)}`);
  console.log("metric: tool output tokens only (chars/4)");
  console.log("");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                               rg_tok  sift_tok   diff   rg_ms  sift_ms  rg_n  sift_n");

    let repoRg = 0;
    let repoSift = 0;

    for (const q of QUERIES) {
      const rg = runRg(repo.root, q);
      const sift = await runSift(repo.id, q);

      const grepTokens = tokStr(rg.output);
      const siftTokens = tokJson(sift.result);
      const tokenDiffPct = pctDiff(siftTokens, grepTokens);
      const speedDiffPct = pctDiff(sift.ms, rg.ms);

      rows.push({
        repo: repo.label, queryId: q.id, query: q.query,
        grepTokens, grepMs: rg.ms, grepLines: rg.lines,
        siftTokens, siftMs: sift.ms, siftItems: sift.items,
        tokenDiffPct, speedDiffPct,
      });

      repoRg += grepTokens;
      repoSift += siftTokens;

      const label = `${q.id} ${q.query}${q.kind ? ` (${q.kind})` : ""}`.slice(0, 34).padEnd(34);
      const diff = tokenDiffPct === null ? "n/a" : `${tokenDiffPct > 0 ? "+" : ""}${tokenDiffPct}%`;
      console.log(
        `${label} ${String(grepTokens).padStart(7)} ${String(siftTokens).padStart(9)} ${diff.padStart(6)} ${String(rg.ms).padStart(6)} ${String(sift.ms).padStart(8)} ${String(rg.lines).padStart(5)} ${String(sift.items).padStart(6)}`,
      );
    }

    const repoDiff = pctDiff(repoSift, repoRg);
    console.log(
      `TOTAL                              ${String(repoRg).padStart(7)} ${String(repoSift).padStart(9)} ${String(repoDiff === null ? "n/a" : `${repoDiff > 0 ? "+" : ""}${repoDiff}%`).padStart(6)}`,
    );
    console.log("");
  }

  const totalRg = rows.reduce((s, r) => s + r.grepTokens, 0);
  const totalSift = rows.reduce((s, r) => s + r.siftTokens, 0);
  const totalRgMs = rows.reduce((s, r) => s + r.grepMs, 0);
  const totalSiftMs = rows.reduce((s, r) => s + r.siftMs, 0);
  const siftWins = rows.filter((r) => r.siftTokens < r.grepTokens).length;
  const rgWins = rows.filter((r) => r.grepTokens < r.siftTokens).length;
  const ties = rows.filter((r) => r.grepTokens === r.siftTokens).length;

  const summary = {
    benchmark: "search_symbols_vs_rg",
    startedAt: startedAt.toISOString(),
    repos: REPOS.map((r) => r.label),
    queries: QUERIES.length,
    totals: {
      rgTokens: totalRg, siftTokens: totalSift, rgMs: totalRgMs, siftMs: totalSiftMs,
      tokenDiffPct: pctDiff(totalSift, totalRg), speedDiffPct: pctDiff(totalSiftMs, totalRgMs),
      siftTokenWins: siftWins, rgTokenWins: rgWins, ties,
    },
    rows,
  };

  console.log("SUMMARY");
  console.log(`rg total tokens:   ${totalRg}`);
  console.log(`sift total tokens: ${totalSift}`);
  console.log(`token diff:        ${summary.totals.tokenDiffPct === null ? "n/a" : `${summary.totals.tokenDiffPct > 0 ? "+" : ""}${summary.totals.tokenDiffPct}%`}  (+ = sift costs more)`);
  console.log(`speed diff:        ${summary.totals.speedDiffPct === null ? "n/a" : `${summary.totals.speedDiffPct > 0 ? "+" : ""}${summary.totals.speedDiffPct}%`}  (+ = sift is slower)`);
  console.log(`sift wins:         ${siftWins}`);
  console.log(`rg wins:           ${rgWins}`);
  console.log(`ties:              ${ties}`);

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `search-symbols-vs-rg-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
