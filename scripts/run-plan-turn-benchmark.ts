#!/usr/bin/env node
/**
 * plan_turn benchmark runner.
 *
 * Reads tests/fixtures/plan-turn-benchmark.jsonl, runs planTurn for each
 * query against the real TOOL_DEFINITIONS, measures:
 * - Recall@5: query counts as hit if any expected_tool appears in top-5
 * - Latency: p50, p95 for cold and warm calls
 *
 * Cold = first call (builds BM25 index + maybe embeds)
 * Warm = subsequent calls (cached)
 *
 * BM25-only path runs without API key. Semantic path requires
 * CODESIFT_OPENAI_API_KEY or CODESIFT_VOYAGE_API_KEY.
 *
 * Uses the local codesift-mcp repo as the benchmark target. Run
 * `codesift index .` first if needed.
 *
 * Usage: npx vitest run scripts/run-plan-turn-benchmark.ts
 *    OR: npx tsx --conditions=require scripts/run-plan-turn-benchmark.ts
 *
 * Note: run via vitest for correct ESM module resolution with prisma-ast alias.
 * Direct tsx invocation may fail if @mrleebo/prisma-ast CJS path is missing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planTurn, _resetPlanTurnCaches } from "../src/tools/plan-turn-tools.js";
import { listAllRepos } from "../src/tools/index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchEntry {
  query: string;
  expected_tools: string[];
  category: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function loadFixture(): BenchEntry[] {
  const fixturePath = join(process.cwd(), "tests/fixtures/plan-turn-benchmark.jsonl");
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf-8");
  } catch (err) {
    console.error(`ERROR: Could not read fixture at ${fixturePath}`);
    console.error((err as Error).message);
    process.exit(1);
  }

  const entries: BenchEntry[] = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as BenchEntry;
      } catch (err) {
        console.error(`ERROR: Invalid JSON on line ${i + 1}: ${line}`);
        process.exit(1);
      }
    });

  return entries;
}

// ---------------------------------------------------------------------------
// Core logic — exported so vitest can run it as a test
// ---------------------------------------------------------------------------

export async function runBenchmark(): Promise<{
  hits: number;
  total: number;
  recall: number;
  coldMs: number;
  p50Warm: number;
  p95Warm: number;
  failures: { query: string; category: string; top5: string[] }[];
}> {
  const entries = loadFixture();
  const EXPECTED_COUNT = 30;
  if (entries.length !== EXPECTED_COUNT) {
    throw new Error(`Expected ${EXPECTED_COUNT} entries, found ${entries.length}`);
  }

  const repos = (await listAllRepos()) as string[];
  if (repos.length === 0) {
    throw new Error(
      "No repos are indexed. Run `codesift index .` from the project root first."
    );
  }
  const codesiftRepo = repos.find((r) => r.includes("codesift-mcp"));
  const repoName = codesiftRepo ?? repos[0]!;

  _resetPlanTurnCaches();

  const coldLatencies: number[] = [];
  const warmLatencies: number[] = [];
  let hits = 0;
  const failures: { query: string; category: string; top5: string[] }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isCold = i === 0;

    const t0 = performance.now();
    let result;
    try {
      result = await planTurn(repoName, entry.query, { skip_session: true });
    } catch (err) {
      failures.push({ query: entry.query, category: entry.category, top5: [] });
      continue;
    }
    const latencyMs = performance.now() - t0;

    if (isCold) {
      coldLatencies.push(latencyMs);
    } else {
      warmLatencies.push(latencyMs);
    }

    // Gap queries: hit if gap_analysis set OR confidence is very low
    if (entry.category === "gap") {
      const hasGap = result.gap_analysis !== undefined;
      const lowConf = result.confidence <= 0.3;
      if (hasGap || lowConf) {
        hits++;
      } else {
        failures.push({
          query: entry.query,
          category: entry.category,
          top5: result.tools.slice(0, 5).map((t) => t.name),
        });
      }
      continue;
    }

    const top5Names = result.tools.slice(0, 5).map((t) => t.name);
    const isHit = entry.expected_tools.some((e) => top5Names.includes(e));

    if (isHit) {
      hits++;
    } else {
      failures.push({ query: entry.query, category: entry.category, top5: top5Names });
    }
  }

  const warmSorted = [...warmLatencies].sort((a, b) => a - b);
  return {
    hits,
    total: entries.length,
    recall: hits / entries.length,
    coldMs: coldLatencies[0] ?? 0,
    p50Warm: percentile(warmSorted, 50),
    p95Warm: percentile(warmSorted, 95),
    failures,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("plan_turn Benchmark Runner");
  console.log("=".repeat(60));

  let repoName: string;
  try {
    const repos = (await listAllRepos()) as string[];
    if (repos.length === 0) {
      console.error(
        "ERROR: No repos are indexed. Run `codesift index .` from the project root first."
      );
      process.exit(2);
    }
    const codesiftRepo = repos.find((r) => r.includes("codesift-mcp"));
    repoName = codesiftRepo ?? repos[0]!;
  } catch (err) {
    console.error("ERROR: Could not list repos.");
    console.error((err as Error).message);
    process.exit(2);
  }
  console.log(`\nUsing repo: ${repoName}\n`);

  const result = await runBenchmark();
  const recallPct = (result.recall * 100).toFixed(1);

  console.log("=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));
  console.log(`Recall@5 : ${result.hits}/${result.total} (${recallPct}%)`);
  console.log(`p50 warm : ${result.p50Warm.toFixed(1)}ms`);
  console.log(`p95 warm : ${result.p95Warm.toFixed(1)}ms`);
  console.log(`cold     : ${result.coldMs.toFixed(1)}ms`);

  if (result.failures.length > 0) {
    console.log(`\nFailed queries (${result.failures.length}):`);
    for (const f of result.failures) {
      console.log(`  [${f.category}] "${f.query}"`);
      console.log(`    top-5 got: ${f.top5.join(", ") || "(none)"}`);
    }
  }

  const SUCCESS_THRESHOLD = 0.70;
  if (result.recall >= SUCCESS_THRESHOLD) {
    console.log(`\nPASS — Recall@5 ${recallPct}% >= ${(SUCCESS_THRESHOLD * 100).toFixed(0)}% threshold`);
    process.exit(0);
  } else {
    console.log(`\nFAIL — Recall@5 ${recallPct}% < ${(SUCCESS_THRESHOLD * 100).toFixed(0)}% threshold`);
    process.exit(1);
  }
}

// Run as CLI when invoked directly
main().catch((err: unknown) => {
  console.error("Unhandled error:", (err as Error).message ?? err);
  process.exit(1);
});
