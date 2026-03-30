/**
 * HONEST benchmark: CodeSift search_text vs native rg (ripgrep)
 *
 * Measures tool output tokens, time, and match counts.
 * Same queries, same repos, side-by-side. No spin.
 *
 * Run: npx tsx benchmarks/search-text-vs-grep.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { searchText } from "../src/tools/search-tools.js";

type RepoDef = { id: string; root: string; label: string };
type QueryDef = { id: string; query: string; regex?: boolean; file_pattern?: string };

interface ResultRow {
  repo: string;
  queryId: string;
  query: string;
  regex: boolean;
  filePattern?: string;
  grepTokens: number;
  grepMs: number;
  grepLines: number;
  siftTokens: number;
  siftMs: number;
  siftItems: number;
  tokenDiffPct: number | null;
  speedDiffPct: number | null;
  coverageFlag: "ok" | "warning";
}

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

const QUERIES: QueryDef[] = [
  { id: "Q01", query: "TODO", file_pattern: "*.ts" },
  { id: "Q02", query: "import", file_pattern: "*.ts" },
  { id: "Q03", query: "export default", file_pattern: "*.ts" },
  { id: "Q04", query: "console.log" },
  { id: "Q05", query: "async function" },
  { id: "Q06", query: "throw new Error", file_pattern: "src/**" },
  { id: "Q07", query: "useState", file_pattern: "*.tsx" },
  { id: "Q08", query: "process.env", file_pattern: "*.ts" },
  { id: "Q09", query: "export (GET|POST|PUT|DELETE)", regex: true },
  { id: "Q10", query: "catch\\s*\\(", regex: true, file_pattern: "*.ts" },
];

const RG_EXCLUDES = [
  "--glob=!node_modules", "--glob=!.git", "--glob=!.next", "--glob=!dist",
  "--glob=!.codesift", "--glob=!coverage", "--glob=!.playwright-mcp",
];

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pctDiff(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return Math.round(((current - baseline) / baseline) * 100);
}

function runRg(root: string, q: QueryDef): { output: string; ms: number; lines: number } {
  const args = ["rg", "--no-heading", "-n"];
  if (!q.regex) args.push("-F");
  if (q.file_pattern) args.push(`--glob='${q.file_pattern}'`);
  args.push(...RG_EXCLUDES, "--", `'${q.query.replace(/'/g, "'\\''")}'`, `'${root}'`);

  const start = performance.now();
  let output = "";
  try {
    output = execSync(args.join(" "), { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) output = String((err as { stdout?: string }).stdout ?? "");
  }
  return { output, ms: Math.round(performance.now() - start), lines: output.split("\n").filter(Boolean).length };
}

async function runSift(repoId: string, q: QueryDef): Promise<{ result: unknown; ms: number; items: number }> {
  const start = performance.now();
  const result = await searchText(repoId, q.query, { regex: q.regex, file_pattern: q.file_pattern, auto_group: true });
  const ms = Math.round(performance.now() - start);
  const items = typeof result === "string" ? result.split("\n").filter(Boolean).length : Array.isArray(result) ? result.length : 0;
  return { result, ms, items };
}

function coverageFlag(grepLines: number, siftItems: number): "ok" | "warning" {
  if (grepLines === 0 && siftItems === 0) return "ok";
  if (grepLines === 0 || siftItems === 0) return "warning";
  return Math.max(grepLines, siftItems) / Math.max(1, Math.min(grepLines, siftItems)) >= 3 ? "warning" : "ok";
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const rows: ResultRow[] = [];

  console.log("search_text vs rg");
  console.log(`date: ${startedAt.toISOString().slice(0, 10)}`);
  console.log("metric: tool output tokens only (chars/4)");
  console.log("");

  for (const repo of REPOS) {
    console.log(`repo: ${repo.label}`);
    console.log("query                               rg_tok  sift_tok   diff   rg_ms  sift_ms  rg_n  sift_n  flag");

    let repoRg = 0;
    let repoSift = 0;

    for (const q of QUERIES) {
      const rg = runRg(repo.root, q);
      const sift = await runSift(repo.id, q);

      const grepTokens = tokStr(rg.output);
      const siftTokens = typeof sift.result === "string" ? tokStr(sift.result) : tokJson(sift.result);
      const tokenDiffPct = pctDiff(siftTokens, grepTokens);
      const speedDiffPct = pctDiff(sift.ms, rg.ms);
      const flag = coverageFlag(rg.lines, sift.items);

      rows.push({
        repo: repo.label, queryId: q.id, query: q.query, regex: Boolean(q.regex),
        filePattern: q.file_pattern, grepTokens, grepMs: rg.ms, grepLines: rg.lines,
        siftTokens, siftMs: sift.ms, siftItems: sift.items,
        tokenDiffPct, speedDiffPct, coverageFlag: flag,
      });

      repoRg += grepTokens;
      repoSift += siftTokens;

      const label = `${q.id} ${q.query}${q.file_pattern ? ` [${q.file_pattern}]` : ""}`.slice(0, 34).padEnd(34);
      const diff = tokenDiffPct === null ? "n/a" : `${tokenDiffPct > 0 ? "+" : ""}${tokenDiffPct}%`;
      console.log(
        `${label} ${String(grepTokens).padStart(7)} ${String(siftTokens).padStart(9)} ${diff.padStart(6)} ${String(rg.ms).padStart(6)} ${String(sift.ms).padStart(8)} ${String(rg.lines).padStart(5)} ${String(sift.items).padStart(6)}  ${flag}`,
      );
    }

    const repoDiff = pctDiff(repoSift, repoRg);
    console.log(
      `TOTAL                              ${String(repoRg).padStart(7)} ${String(repoSift).padStart(9)} ${String(repoDiff === null ? "n/a" : `${repoDiff > 0 ? "+" : ""}${repoDiff}%`).padStart(6)}`,
    );
    console.log("");
  }

  // Grand summary
  const totalRg = rows.reduce((s, r) => s + r.grepTokens, 0);
  const totalSift = rows.reduce((s, r) => s + r.siftTokens, 0);
  const totalRgMs = rows.reduce((s, r) => s + r.grepMs, 0);
  const totalSiftMs = rows.reduce((s, r) => s + r.siftMs, 0);
  const siftWins = rows.filter((r) => r.siftTokens < r.grepTokens).length;
  const rgWins = rows.filter((r) => r.grepTokens < r.siftTokens).length;
  const ties = rows.filter((r) => r.grepTokens === r.siftTokens).length;
  const warnings = rows.filter((r) => r.coverageFlag === "warning").length;

  const summary = {
    benchmark: "search_text_vs_rg",
    startedAt: startedAt.toISOString(),
    repos: REPOS.map((r) => r.label),
    queries: QUERIES.length,
    totals: {
      rgTokens: totalRg, siftTokens: totalSift, rgMs: totalRgMs, siftMs: totalSiftMs,
      tokenDiffPct: pctDiff(totalSift, totalRg), speedDiffPct: pctDiff(totalSiftMs, totalRgMs),
      siftTokenWins: siftWins, rgTokenWins: rgWins, ties, coverageWarnings: warnings,
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
  console.log(`warnings:          ${warnings}`);
  console.log("");

  console.log("VERDICT");
  if (totalSift > totalRg) {
    console.log(`search_text produced ${Math.abs(summary.totals.tokenDiffPct ?? 0)}% MORE tokens than rg.`);
  } else if (totalSift < totalRg) {
    console.log(`search_text produced ${Math.abs(summary.totals.tokenDiffPct ?? 0)}% FEWER tokens than rg.`);
  } else {
    console.log("No meaningful difference.");
  }
  console.log("This measures direct tool output only, not full agent workflow.");

  // Save JSON
  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `search-text-vs-rg-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
