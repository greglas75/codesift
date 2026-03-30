/**
 * get_file_outline vs Read (cat) — Tool Output Token Benchmark
 *
 * get_file_outline returns symbol structure only (name, kind, line, signature).
 * Read equivalent: reading the entire file content.
 *
 * Run: npx tsx benchmarks/get-file-outline-vs-read.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { getFileOutline } from "../src/tools/outline-tools.js";

type RepoDef = { id: string; root: string; label: string };
type FileDef = {
  id: string;
  path: string; // relative to repo root
  description: string;
};

interface ResultRow {
  repo: string;
  fileId: string;
  filePath: string;
  fileLines: number;
  readTokens: number;
  readMs: number;
  outlineTokens: number;
  outlineMs: number;
  outlineSymbols: number;
  tokenDiffPct: number | null;
  speedDiffPct: number | null;
}

const REPOS: RepoDef[] = [
  { id: "local/codesift-mcp", root: "/Users/greglas/DEV/codesift-mcp", label: "codesift-mcp" },
  { id: "local/translation-qa", root: "/Users/greglas/DEV/translation-qa", label: "translation-qa" },
  { id: "local/promptvault", root: "/Users/greglas/DEV/Methodology Platform/promptvault", label: "promptvault" },
];

// Real files of varying sizes — what agents actually outline
const FILES_PER_REPO: Record<string, FileDef[]> = {
  "codesift-mcp": [
    { id: "F01", path: "src/tools/search-tools.ts", description: "search tools (611 lines)" },
    { id: "F02", path: "src/tools/outline-tools.ts", description: "outline tools" },
    { id: "F03", path: "src/types.ts", description: "type definitions" },
    { id: "F04", path: "src/retrieval/codebase-retrieval.ts", description: "batch retrieval" },
    { id: "F05", path: "src/register-tools.ts", description: "tool registration" },
    { id: "F06", path: "src/server-helpers.ts", description: "server helpers" },
    { id: "F07", path: "src/config.ts", description: "config" },
    { id: "F08", path: "src/tools/graph-tools.ts", description: "graph tools" },
    { id: "F09", path: "src/search/bm25.ts", description: "BM25 index" },
    { id: "F10", path: "src/tools/symbol-tools.ts", description: "symbol tools" },
  ],
  "translation-qa": [
    { id: "F01", path: "lib/services/hitl/consensus.service.ts", description: "consensus (647 lines)" },
    { id: "F02", path: "lib/services/project/project-metadata.service.ts", description: "project metadata (621 lines)" },
    { id: "F03", path: "lib/services/glossary/term-extraction.service.ts", description: "term extraction (594 lines)" },
    { id: "F04", path: "lib/utils/text-diff.ts", description: "text diff (581 lines)" },
    { id: "F05", path: "lib/services/agent-review.service.ts", description: "agent review (169 lines)" },
    { id: "F06", path: "lib/services/ai-task.service.ts", description: "AI task service" },
    { id: "F07", path: "lib/services/batch-update.service.ts", description: "batch update" },
    { id: "F08", path: "lib/services/analysis-status.service.ts", description: "analysis status" },
    { id: "F09", path: "app/api/projects/create-stream/route.ts", description: "create stream API" },
    { id: "F10", path: "components/ProjectForm/ProjectForm.tsx", description: "project form component" },
  ],
  "promptvault": [
    { id: "F01", path: "src/lib/services/risk/risk.service.ts", description: "risk service (181 lines)" },
    { id: "F02", path: "src/types/index.ts", description: "type index (291 lines)" },
    { id: "F03", path: "src/types/search.ts", description: "search types" },
    { id: "F04", path: "src/types/permissions.ts", description: "permission types" },
    { id: "F05", path: "src/types/legal.ts", description: "legal types" },
    { id: "F06", path: "src/app/layout.tsx", description: "app layout" },
    { id: "F07", path: "prisma/seed.ts", description: "prisma seed" },
    { id: "F08", path: "src/app/api/v1/rate-limits/route.ts", description: "rate limits API" },
    { id: "F09", path: "src/app/api/v1/organizations/route.ts", description: "organizations API" },
    { id: "F10", path: "prisma.config.ts", description: "prisma config" },
  ],
};

function tokStr(s: string): number { return Math.ceil(s.length / 4); }
function tokJson(v: unknown): number { return Math.ceil(JSON.stringify(v, null, 2).length / 4); }
function pctDiff(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return Math.round(((current - baseline) / baseline) * 100);
}

function runRead(root: string, filePath: string): { content: string; ms: number; lines: number } {
  const start = performance.now();
  let content = "";
  try {
    content = readFileSync(path.join(root, filePath), "utf-8");
  } catch {
    // file doesn't exist
  }
  return { content, ms: Math.round(performance.now() - start), lines: content.split("\n").length };
}

async function runOutline(repoId: string, filePath: string): Promise<{ result: unknown; ms: number; symbols: number }> {
  const start = performance.now();
  let result: unknown;
  let symbols = 0;
  try {
    result = await getFileOutline(repoId, filePath);
    if (result && typeof result === "object" && "symbols" in result) {
      symbols = (result as { symbols: unknown[] }).symbols.length;
    }
  } catch {
    result = { symbols: [], error: "file not indexed" };
  }
  return { result, ms: Math.round(performance.now() - start), symbols };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const rows: ResultRow[] = [];

  console.log("get_file_outline vs Read");
  console.log(`date: ${startedAt.toISOString().slice(0, 10)}`);
  console.log("metric: tool output tokens only (chars/4)");
  console.log("Read = full file content. Outline = symbols only (name, kind, line, signature).");
  console.log("");

  for (const repo of REPOS) {
    const files = FILES_PER_REPO[repo.label];
    if (!files) continue;

    console.log(`repo: ${repo.label}`);
    console.log("file                                read_tok  outl_tok   diff  read_ms outl_ms lines  syms");

    let repoRead = 0;
    let repoOutline = 0;

    for (const f of files) {
      const read = runRead(repo.root, f.path);
      const outline = await runOutline(repo.id, f.path);

      const readTokens = tokStr(read.content);
      const outlineTokens = tokJson(outline.result);
      const tokenDiffPct = pctDiff(outlineTokens, readTokens);
      const speedDiffPct = pctDiff(outline.ms, read.ms);

      rows.push({
        repo: repo.label, fileId: f.id, filePath: f.path,
        fileLines: read.lines, readTokens, readMs: read.ms,
        outlineTokens, outlineMs: outline.ms, outlineSymbols: outline.symbols,
        tokenDiffPct, speedDiffPct,
      });

      repoRead += readTokens;
      repoOutline += outlineTokens;

      const label = `${f.id} ${f.path}`.slice(0, 34).padEnd(34);
      const diff = tokenDiffPct === null ? "n/a" : `${tokenDiffPct > 0 ? "+" : ""}${tokenDiffPct}%`;
      console.log(
        `${label} ${String(readTokens).padStart(8)} ${String(outlineTokens).padStart(9)} ${diff.padStart(6)} ${String(read.ms).padStart(7)} ${String(outline.ms).padStart(7)} ${String(read.lines).padStart(5)} ${String(outline.symbols).padStart(5)}`,
      );
    }

    const repoDiff = pctDiff(repoOutline, repoRead);
    console.log(
      `TOTAL                              ${String(repoRead).padStart(8)} ${String(repoOutline).padStart(9)} ${String(repoDiff === null ? "n/a" : `${repoDiff > 0 ? "+" : ""}${repoDiff}%`).padStart(6)}`,
    );
    console.log("");
  }

  const totalRead = rows.reduce((s, r) => s + r.readTokens, 0);
  const totalOutline = rows.reduce((s, r) => s + r.outlineTokens, 0);
  const totalReadMs = rows.reduce((s, r) => s + r.readMs, 0);
  const totalOutlineMs = rows.reduce((s, r) => s + r.outlineMs, 0);
  const outlineWins = rows.filter((r) => r.outlineTokens < r.readTokens).length;
  const readWins = rows.filter((r) => r.readTokens < r.outlineTokens).length;
  const ties = rows.filter((r) => r.readTokens === r.outlineTokens).length;

  const summary = {
    benchmark: "get_file_outline_vs_read",
    startedAt: startedAt.toISOString(),
    repos: REPOS.map((r) => r.label),
    filesPerRepo: 10,
    totals: {
      readTokens: totalRead, outlineTokens: totalOutline, readMs: totalReadMs, outlineMs: totalOutlineMs,
      tokenDiffPct: pctDiff(totalOutline, totalRead), speedDiffPct: pctDiff(totalOutlineMs, totalReadMs),
      outlineWins, readWins, ties,
    },
    rows,
  };

  console.log("SUMMARY");
  console.log(`read total tokens:    ${totalRead}`);
  console.log(`outline total tokens: ${totalOutline}`);
  console.log(`token diff:           ${summary.totals.tokenDiffPct === null ? "n/a" : `${summary.totals.tokenDiffPct > 0 ? "+" : ""}${summary.totals.tokenDiffPct}%`}  (+ = outline costs more)`);
  console.log(`speed diff:           ${summary.totals.speedDiffPct === null ? "n/a" : `${summary.totals.speedDiffPct > 0 ? "+" : ""}${summary.totals.speedDiffPct}%`}  (+ = outline is slower)`);
  console.log(`outline wins:         ${outlineWins}`);
  console.log(`read wins:            ${readWins}`);
  console.log(`ties:                 ${ties}`);

  const resultsDir = path.join(process.cwd(), "benchmarks", "results");
  mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(resultsDir, `get-file-outline-vs-read-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nsaved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
