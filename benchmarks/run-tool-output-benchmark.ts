/**
 * Automated benchmark runner — measures tool OUTPUT tokens for all categories.
 * Uses local/promptvault as the standard benchmark repo.
 *
 * NOTE: Historical baselines (A/B/C/E) measured full agent session tokens
 * (system prompt ~45K + tool output + model reasoning). This benchmark measures
 * ONLY tool output (JSON serialized with indent=2, length/4).
 *
 * Run: npx tsx benchmarks/run-benchmark.ts
 */
import { searchText } from "../src/tools/search-tools.js";
import { searchSymbols } from "../src/tools/search-tools.js";
import { getFileTree } from "../src/tools/outline-tools.js";
import { getSymbol, getSymbols, findReferences } from "../src/tools/symbol-tools.js";
import { traceCallChain } from "../src/tools/graph-tools.js";
import { listAllRepos } from "../src/tools/index-tools.js";
import { codebaseRetrieval } from "../src/retrieval/codebase-retrieval.js";

const REPO = "local/promptvault";

function tokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data, null, 2).length / 4);
}

interface BenchmarkResult {
  task: string;
  tokens: number;
  ms: number;
  note?: string;
}

async function measure(task: string, fn: () => Promise<unknown>, note?: string): Promise<BenchmarkResult> {
  const start = performance.now();
  const data = await fn();
  const ms = Math.round(performance.now() - start);
  const tok = tokens(data);
  return { task, tokens: tok, ms, note };
}

// ---------------------------------------------------------------------------
// Category A: Text Search — default vs optimized (auto_group)
// ---------------------------------------------------------------------------
async function benchmarkA(): Promise<BenchmarkResult[]> {
  const tasks = [
    { id: "A1", q: "prisma.$transaction", opts: { file_pattern: "*.service.ts" } },
    { id: "A2", q: "@/lib/errors", opts: {} },
    { id: "A3", q: "TODO|FIXME", opts: { regex: true, file_pattern: "src/**" } },
    { id: "A4", q: "withAuth", opts: {} },
    { id: "A5", q: "process\\.env\\[", opts: { regex: true } },
    { id: "A6", q: "async function.*Risk", opts: { regex: true } },
    { id: "A7", q: "throw new AppError", opts: {} },
    { id: "A8", q: "redis", opts: { file_pattern: "src/**" } },
    { id: "A9", q: "export (GET|POST|PATCH|DELETE)", opts: { regex: true } },
    { id: "A10", q: "console.log", opts: { file_pattern: "src/**" } },
  ];

  const results: BenchmarkResult[] = [];

  for (const t of tasks) {
    // Default (no grouping)
    const def = await measure(`${t.id}: ${t.q} (default)`, () =>
      searchText(REPO, t.q, t.opts as Parameters<typeof searchText>[2]));

    // With auto_group optimization
    const opt = await measure(`${t.id}: ${t.q} (auto_group)`, () =>
      searchText(REPO, t.q, { ...t.opts, auto_group: true } as Parameters<typeof searchText>[2]));

    const saved = def.tokens > 0 ? Math.round((1 - opt.tokens / def.tokens) * 100) : 0;
    results.push({ ...def, note: `${def.tokens} tok` });
    results.push({ ...opt, note: saved > 0 ? `${saved}% saved` : "same" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Category B: Symbol Search
// ---------------------------------------------------------------------------
async function benchmarkB(): Promise<BenchmarkResult[]> {
  return Promise.all([
    measure("B1: createRisk function", () =>
      searchSymbols(REPO, "createRisk", { kind: "function" })),
    measure("B2: DocumentDetail interface", () =>
      searchSymbols(REPO, "DocumentDetail", { kind: "interface" })),
    measure("B3: use* hooks in *.tsx (top 10)", () =>
      searchSymbols(REPO, "use", { kind: "function", file_pattern: "*.tsx", top_k: 10 })),
    measure("B4: functions in *risk.service*", () =>
      searchSymbols(REPO, "", { file_pattern: "*risk.service*" })),
    measure("B5: AuditAction type", () =>
      searchSymbols(REPO, "AuditAction", { kind: "type" })),
    measure("B6: create* (top 20)", () =>
      searchSymbols(REPO, "create", { top_k: 20 })),
    measure("B7: RiskSummary interface", () =>
      searchSymbols(REPO, "RiskSummary", { kind: "interface" })),
    measure("B9: RiskPanel in *.tsx", () =>
      searchSymbols(REPO, "RiskPanel", { kind: "function", file_pattern: "*.tsx" })),
    measure("B10: withWorkspace (with source)", () =>
      searchSymbols(REPO, "withWorkspace", { kind: "function", include_source: true })),
    // Verify Fix 2: no tokens/repo fields
    measure("B1-no-source: createRisk (no source)", () =>
      searchSymbols(REPO, "createRisk", { kind: "function", include_source: false })),
  ]);
}

// ---------------------------------------------------------------------------
// Category C: File Structure
// ---------------------------------------------------------------------------
async function benchmarkC(): Promise<BenchmarkResult[]> {
  return Promise.all([
    measure("C1: src/ (compact)", () =>
      getFileTree(REPO, { path_prefix: "src", compact: true })),
    measure("C2: src/ depth 2 (compact)", () =>
      getFileTree(REPO, { path_prefix: "src", depth: 2, compact: true })),
    measure("C3: *.test.* (compact)", () =>
      getFileTree(REPO, { name_pattern: "*.test.*", compact: true })),
    measure("C6: >20 symbols (compact)", () =>
      getFileTree(REPO, { path_prefix: "src", min_symbols: 20, compact: true })),
    measure("C9: full repo (compact)", () =>
      getFileTree(REPO, { compact: true })),
    measure("C1-FULL: src/ (full mode)", () =>
      getFileTree(REPO, { path_prefix: "src" }),
      "comparison: compact vs full"),
  ]);
}

// ---------------------------------------------------------------------------
// Category E: Relationships
// ---------------------------------------------------------------------------
async function benchmarkE(): Promise<BenchmarkResult[]> {
  return Promise.all([
    measure("E1: callers of createRisk", () =>
      traceCallChain(REPO, "createRisk", "callers", { depth: 1 })),
    measure("E2: callees of analyzeDocument", () =>
      traceCallChain(REPO, "analyzeDocument", "callees", { depth: 1 })),
    measure("E3: createRisk callees depth 2", () =>
      traceCallChain(REPO, "createRisk", "callees", { depth: 2 })),
    measure("E4: refs RiskSummary", () =>
      findReferences(REPO, "RiskSummary")),
    measure("E5: refs withAuth", () =>
      findReferences(REPO, "withAuth")),
    measure("E7: refs getRiskById", () =>
      findReferences(REPO, "getRiskById")),
  ]);
}

// ---------------------------------------------------------------------------
// Fix 1: list_repos compact vs full
// ---------------------------------------------------------------------------
async function benchmarkListRepos(): Promise<BenchmarkResult[]> {
  return Promise.all([
    measure("list_repos COMPACT (default)", () =>
      listAllRepos({ compact: true })),
    measure("list_repos FULL (verbose)", () =>
      listAllRepos({ compact: false })),
  ]);
}

// ---------------------------------------------------------------------------
// Batch retrieval
// ---------------------------------------------------------------------------
async function benchmarkBatch(): Promise<BenchmarkResult[]> {
  // Sequential equivalent (what agents do without batching)
  const seqResults: BenchmarkResult[] = [];
  const seqStart = performance.now();
  const r1 = await searchText(REPO, "prisma.$transaction", { file_pattern: "*.service.ts" });
  const r2 = await searchSymbols(REPO, "createRisk");
  const r3 = await getFileTree(REPO, { path_prefix: "src/lib/services", compact: true });
  const r4 = await findReferences(REPO, "withAuth");
  const r5 = await traceCallChain(REPO, "createRisk", "callees", { depth: 1 });
  const seqMs = Math.round(performance.now() - seqStart);
  const seqTokens = tokens(r1) + tokens(r2) + tokens(r3) + tokens(r4) + tokens(r5);

  seqResults.push({ task: "Sequential: 5 separate calls", tokens: seqTokens, ms: seqMs });

  // Batched equivalent
  const batchResult = await measure("Batched: codebase_retrieval (5 queries)", () =>
    codebaseRetrieval(REPO, [
      { type: "text", query: "prisma.$transaction", file_pattern: "*.service.ts" },
      { type: "symbols", query: "createRisk" },
      { type: "file_tree", path: "src/lib/services" },
      { type: "references", symbol_name: "withAuth" },
      { type: "call_chain", symbol_name: "createRisk", direction: "callees" },
    ], 10000));

  return [...seqResults, batchResult];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║           CodeSift Benchmark Suite (Tool Output)             ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  Repo: ${REPO.padEnd(54)}║`);
  console.log(`║  Date: ${new Date().toISOString().slice(0, 10).padEnd(54)}║`);
  console.log(`║  Metric: JSON output tokens (chars/4, indent=2)${" ".repeat(14)}║`);
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log();

  // Category B
  console.log("━━━ Category B: Symbol Search (search_symbols) ━━━");
  const bResults = await benchmarkB();
  let bTotal = 0;
  for (const r of bResults) {
    console.log(`  ${r.task.padEnd(45)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(5)}ms`);
    bTotal += r.tokens;
  }
  console.log(`  ${"SUBTOTAL".padEnd(45)} ${String(bTotal).padStart(7)} tok`);
  const bWithSource = bResults.filter(r => !r.task.includes("no-source")).reduce((s, r) => s + r.tokens, 0);
  const bNoSource = bResults.find(r => r.task.includes("no-source"));
  if (bNoSource) {
    const bWithSourceB1 = bResults.find(r => r.task.startsWith("B1:"));
    if (bWithSourceB1) {
      console.log(`  Fix 2 check: B1 with source=${bWithSourceB1.tokens} tok, no source=${bNoSource.tokens} tok (${Math.round((1 - bNoSource.tokens / bWithSourceB1.tokens) * 100)}% saved)`);
    }
  }
  console.log();

  // Category C
  console.log("━━━ Category C: File Structure (get_file_tree) ━━━");
  const cResults = await benchmarkC();
  const cCompact = cResults.filter(r => !r.task.includes("FULL"));
  const cFull = cResults.find(r => r.task.includes("FULL"));
  const cCompactTotal = cCompact.reduce((s, r) => s + r.tokens, 0);
  for (const r of cResults) {
    console.log(`  ${r.task.padEnd(45)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(5)}ms`);
  }
  console.log(`  ${"SUBTOTAL (compact only)".padEnd(45)} ${String(cCompactTotal).padStart(7)} tok`);
  if (cFull) {
    const c1Compact = cResults.find(r => r.task.startsWith("C1:"));
    if (c1Compact) {
      console.log(`  Compact vs Full: ${c1Compact.tokens} vs ${cFull.tokens} (${Math.round((1 - c1Compact.tokens / cFull.tokens) * 100)}% saved)`);
    }
  }
  console.log();

  // Category E
  console.log("━━━ Category E: Relationships (refs + trace) ━━━");
  const eResults = await benchmarkE();
  let eTotal = 0;
  for (const r of eResults) {
    console.log(`  ${r.task.padEnd(45)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(5)}ms`);
    eTotal += r.tokens;
  }
  console.log(`  ${"SUBTOTAL".padEnd(45)} ${String(eTotal).padStart(7)} tok`);
  console.log();

  // list_repos
  console.log("━━━ Fix 1: list_repos (compact optimization) ━━━");
  const lResults = await benchmarkListRepos();
  for (const r of lResults) {
    console.log(`  ${r.task.padEnd(45)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(5)}ms`);
  }
  const compact = lResults.find(r => r.task.includes("COMPACT"));
  const full = lResults.find(r => r.task.includes("FULL"));
  if (compact && full) {
    console.log(`  Savings: ${Math.round((1 - compact.tokens / full.tokens) * 100)}% reduction (${full.tokens - compact.tokens} tok saved per call)`);
    console.log(`  At 186 calls/day: ~${Math.round((full.tokens - compact.tokens) * 186 / 1000)}K tokens saved`);
  }
  console.log();

  // Batch
  console.log("━━━ Batch vs Sequential (codebase_retrieval) ━━━");
  const batchResults = await benchmarkBatch();
  for (const r of batchResults) {
    console.log(`  ${r.task.padEnd(45)} ${String(r.tokens).padStart(7)} tok  ${String(r.ms).padStart(5)}ms`);
  }
  const seq = batchResults.find(r => r.task.includes("Sequential"));
  const batch = batchResults.find(r => r.task.includes("Batched"));
  if (seq && batch) {
    console.log(`  Batch saves: ${Math.round((1 - batch.tokens / seq.tokens) * 100)}% tokens, ${Math.round((1 - batch.ms / seq.ms) * 100)}% time`);
  }
  console.log();

  // Category A (run last — slowest due to file walking)
  console.log("━━━ Category A: Text Search — default vs auto_group ━━━");
  const aResults = await benchmarkA();
  let aDefaultTotal = 0;
  let aOptTotal = 0;
  for (let i = 0; i < aResults.length; i += 2) {
    const def = aResults[i]!;
    const opt = aResults[i + 1]!;
    const saved = def.tokens > 0 ? Math.round((1 - opt.tokens / def.tokens) * 100) : 0;
    const savedStr = saved > 0 ? `  ↓${saved}%` : "";
    console.log(`  ${def.task.replace(" (default)", "").padEnd(40)} default=${String(def.tokens).padStart(6)} tok  auto_group=${String(opt.tokens).padStart(6)} tok${savedStr}`);
    aDefaultTotal += def.tokens;
    aOptTotal += opt.tokens;
  }
  const aSaved = Math.round((1 - aOptTotal / aDefaultTotal) * 100);
  console.log(`  ${"TOTAL".padEnd(40)} default=${String(aDefaultTotal).padStart(6)} tok  auto_group=${String(aOptTotal).padStart(6)} tok  ↓${aSaved}%`);
  console.log();

  // Summary
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║                     OPTIMIZATION SUMMARY                     ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  if (compact && full) {
    console.log(`║  Fix 1: list_repos compact     ${String(compact.tokens).padStart(6)} vs ${String(full.tokens).padStart(6)} tok  ↓${Math.round((1 - compact.tokens / full.tokens) * 100)}%`.padEnd(64) + "║");
  }
  const b1With = bResults.find(r => r.task.startsWith("B1:"));
  if (b1With && bNoSource) {
    console.log(`║  Fix 2: search_symbols cleanup  ${String(bNoSource.tokens).padStart(6)} vs ${String(b1With.tokens).padStart(6)} tok  ↓${Math.round((1 - bNoSource.tokens / b1With.tokens) * 100)}% (no-source)`.padEnd(64) + "║");
  }
  console.log(`║  Fix 3: auto_group search_text ${String(aOptTotal).padStart(6)} vs ${String(aDefaultTotal).padStart(6)} tok  ↓${aSaved}%`.padEnd(64) + "║");
  if (seq && batch) {
    console.log(`║  Batch vs sequential           ${String(batch.tokens).padStart(6)} vs ${String(seq.tokens).padStart(6)} tok  ↓${Math.round((1 - batch.tokens / seq.tokens) * 100)}%`.padEnd(64) + "║");
  }
  console.log("╚═══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
