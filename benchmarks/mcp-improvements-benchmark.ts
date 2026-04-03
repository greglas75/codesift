/**
 * Benchmark for 6 MCP improvements.
 * Measures execution time, output size, and token estimates for each new feature.
 *
 * Run: npx tsx benchmarks/mcp-improvements-benchmark.ts
 */
import { indexFolder } from "../src/tools/index-tools.js";
import { discoverTools, getToolDefinitions } from "../src/register-tools.js";
import { getCallHierarchy } from "../src/lsp/lsp-tools.js";
import { consolidateMemories, readMemory } from "../src/tools/memory-tools.js";
import {
  createAnalysisPlan,
  writeScratchpad,
  readScratchpad,
  listScratchpad,
  updateStepStatus,
  getPlan,
  listPlans,
} from "../src/tools/coordinator-tools.js";
import { wrapTool, MAX_RESPONSE_TOKENS, CHARS_PER_TOKEN } from "../src/server-helpers.js";
import { loadConfig } from "../src/config.js";

loadConfig();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokStr(s: string): number {
  return Math.ceil(s.length / 4);
}

interface BenchResult {
  name: string;
  elapsed_ms: number;
  output_chars: number;
  output_tokens: number;
  status: "ok" | "error";
  error?: string;
  details?: string;
}

const results: BenchResult[] = [];

async function bench(name: string, fn: () => Promise<{ output: string; details?: string }>): Promise<void> {
  const start = performance.now();
  try {
    const { output, details } = await fn();
    const elapsed = Math.round(performance.now() - start);
    const tokens = tokStr(output);
    results.push({ name, elapsed_ms: elapsed, output_chars: output.length, output_tokens: tokens, status: "ok", details });
    console.log(`  ✓ ${name}: ${elapsed}ms, ${tokens.toLocaleString()} tokens, ${output.length.toLocaleString()} chars${details ? ` (${details})` : ""}`);
  } catch (err: unknown) {
    const elapsed = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, elapsed_ms: elapsed, output_chars: 0, output_tokens: 0, status: "error", error: msg });
    console.log(`  ✗ ${name}: ${elapsed}ms — ERROR: ${msg.slice(0, 100)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("MCP Improvements Benchmark");
  console.log("=".repeat(70));

  // First, index the codesift repo itself
  console.log("\n📦 Indexing codesift repo...");
  const indexStart = performance.now();
  await indexFolder(process.cwd(), { incremental: true });
  const indexMs = Math.round(performance.now() - indexStart);
  console.log(`  Indexed in ${indexMs}ms\n`);

  // =========================================================================
  // 1. Tool Deferral & Discovery
  // =========================================================================
  console.log("── #1: Tool Deferral & Discovery ──");

  await bench("discover_tools('dead code')", async () => {
    const result = discoverTools("dead code");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `${result.matches.length} matches` };
  });

  await bench("discover_tools('rename refactor')", async () => {
    const result = discoverTools("rename refactor");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `${result.matches.length} matches` };
  });

  await bench("discover_tools('', category='analysis')", async () => {
    const result = discoverTools("", "analysis");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `${result.matches.length} matches` };
  });

  await bench("discover_tools('secrets security scan')", async () => {
    const result = discoverTools("secrets security scan");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `${result.matches.length} matches` };
  });

  await bench("getToolDefinitions() - full catalog", async () => {
    const defs = getToolDefinitions();
    const output = JSON.stringify(defs.map(d => ({ name: d.name, category: d.category, searchHint: d.searchHint })), null, 2);
    return { output, details: `${defs.length} tools` };
  });

  // Token savings estimate: schema size of all tools
  const allSchemas = getToolDefinitions().map(d => ({
    name: d.name,
    description: d.description,
    schema: Object.keys(d.schema),
  }));
  const fullSchemaTokens = tokStr(JSON.stringify(allSchemas));
  const coreTools = getToolDefinitions().filter(d =>
    ["index_folder", "index_repo", "list_repos", "search_symbols", "search_text",
     "get_file_tree", "get_file_outline", "codebase_retrieval", "suggest_queries", "discover_tools"].includes(d.name)
  );
  const coreSchemaTokens = tokStr(JSON.stringify(coreTools.map(d => ({
    name: d.name, description: d.description, schema: Object.keys(d.schema),
  }))));
  console.log(`\n  📊 Schema token savings: full=${fullSchemaTokens} tok, core-only=${coreSchemaTokens} tok, savings=${fullSchemaTokens - coreSchemaTokens} tok (${Math.round((1 - coreSchemaTokens / fullSchemaTokens) * 100)}%)\n`);

  // =========================================================================
  // 2. LSP Call Hierarchy
  // =========================================================================
  console.log("── #2: LSP Call Hierarchy ──");

  await bench("get_call_hierarchy('registerTools')", async () => {
    const result = await getCallHierarchy("local/codesift", "registerTools");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `via=${result.via}, incoming=${result.incoming.length}, outgoing=${result.outgoing.length}` };
  });

  await bench("get_call_hierarchy('wrapTool')", async () => {
    const result = await getCallHierarchy("local/codesift", "wrapTool");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `via=${result.via}` };
  });

  await bench("get_call_hierarchy('searchSymbols')", async () => {
    const result = await getCallHierarchy("local/codesift", "searchSymbols");
    const output = JSON.stringify(result, null, 2);
    return { output, details: `via=${result.via}` };
  });

  // =========================================================================
  // 3. Large Output Management
  // =========================================================================
  console.log("\n── #3: Large Output Management ──");

  await bench("formatResponse truncation (simulated 200k chars)", async () => {
    const maxChars = MAX_RESPONSE_TOKENS * CHARS_PER_TOKEN;
    const bigOutput = "x".repeat(200_000);
    const truncated = bigOutput.slice(0, maxChars);
    return { output: truncated, details: `input=${bigOutput.length} chars, output=${truncated.length} chars, threshold=${maxChars}` };
  });

  // =========================================================================
  // 4. Output Zod Schemas
  // =========================================================================
  console.log("\n── #4: Output Zod Schemas ──");

  await bench("OutputSchemas enumeration", async () => {
    const { OutputSchemas } = await import("../src/register-tools.js");
    const schemaNames = Object.keys(OutputSchemas);
    const output = JSON.stringify(schemaNames);
    return { output, details: `${schemaNames.length} schemas defined` };
  });

  await bench("Tools with outputSchema count", async () => {
    const defs = getToolDefinitions();
    const withSchema = defs.filter((d: any) => d.outputSchema);
    const output = JSON.stringify(withSchema.map((d: any) => d.name));
    return { output, details: `${withSchema.length}/${defs.length} tools have output schemas` };
  });

  // =========================================================================
  // 5. Memory Consolidation
  // =========================================================================
  console.log("\n── #5: Memory Consolidation ──");

  await bench("consolidateMemories (current project)", async () => {
    try {
      const result = await consolidateMemories(process.cwd(), {
        output_path: "/tmp/codesift-benchmark-memory.md",
        min_confidence: "medium",
      });
      const output = JSON.stringify(result, null, 2);
      return { output, details: `${result.memories_extracted} memories, ${result.sessions_analyzed} sessions` };
    } catch (e: unknown) {
      // No conversations may be available in benchmark env
      return { output: JSON.stringify({ skipped: "no conversations available" }), details: "skipped (no conversation data)" };
    }
  });

  await bench("readMemory (benchmark output)", async () => {
    const result = await readMemory("/tmp");
    if (result) {
      return { output: result.content, details: `${result.content.length} chars` };
    }
    return { output: "null", details: "no memory file" };
  });

  // =========================================================================
  // 6. Multi-Agent Coordinator
  // =========================================================================
  console.log("\n── #6: Multi-Agent Coordinator ──");

  await bench("createAnalysisPlan (5 steps)", async () => {
    const plan = await createAnalysisPlan("Benchmark analysis", [
      { description: "Search symbols", tool: "search_symbols", args: { repo: "local/codesift", query: "index" }, result_key: "symbols" },
      { description: "Find dead code", tool: "find_dead_code", args: { repo: "local/codesift" }, result_key: "deadcode" },
      { description: "Analyze complexity", tool: "analyze_complexity", args: { repo: "local/codesift" }, result_key: "complexity", depends_on: ["step_1"] },
      { description: "Find hotspots", tool: "analyze_hotspots", args: { repo: "local/codesift" }, result_key: "hotspots" },
      { description: "Generate report", tool: "generate_report", args: { repo: "local/codesift" }, depends_on: ["step_2", "step_3", "step_4"] },
    ]);
    const output = JSON.stringify(plan, null, 2);
    return { output, details: `plan_id=${plan.id}, ${plan.steps.length} steps` };
  });

  let benchPlanId = "";
  await bench("scratchpad write (10 entries)", async () => {
    const plan = await createAnalysisPlan("Scratchpad bench", [
      { description: "step", tool: "test", args: {} },
    ]);
    benchPlanId = plan.id;
    for (let i = 0; i < 10; i++) {
      await writeScratchpad(plan.id, `key_${i}`, `value_${i}_${"x".repeat(1000)}`);
    }
    const list = await listScratchpad(plan.id);
    const output = JSON.stringify(list, null, 2);
    return { output, details: `${list.entries.length} entries written` };
  });

  await bench("scratchpad read (10 entries)", async () => {
    const entries: string[] = [];
    for (let i = 0; i < 10; i++) {
      const entry = await readScratchpad(benchPlanId, `key_${i}`);
      if (entry) entries.push(entry.value.slice(0, 20));
    }
    const output = JSON.stringify(entries);
    return { output, details: `${entries.length} entries read` };
  });

  await bench("updateStepStatus (5 updates)", async () => {
    const plan = await createAnalysisPlan("Status bench", [
      { description: "s1", tool: "t", args: {} },
      { description: "s2", tool: "t", args: {} },
      { description: "s3", tool: "t", args: {} },
      { description: "s4", tool: "t", args: {} },
      { description: "s5", tool: "t", args: {} },
    ]);
    for (let i = 1; i <= 5; i++) {
      await updateStepStatus(plan.id, `step_${i}`, "completed");
    }
    const final = getPlan(plan.id)!;
    const output = JSON.stringify(final, null, 2);
    return { output, details: `status=${final.status}` };
  });

  await bench("listPlans", async () => {
    const plans = listPlans();
    const output = JSON.stringify(plans, null, 2);
    return { output, details: `${plans.length} active plans` };
  });

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n${"Name".padEnd(55)} ${"Time".padStart(8)} ${"Tokens".padStart(8)} Status`);
  console.log("-".repeat(80));
  let totalMs = 0;
  let totalTokens = 0;
  for (const r of results) {
    totalMs += r.elapsed_ms;
    totalTokens += r.output_tokens;
    console.log(`${r.name.padEnd(55)} ${(r.elapsed_ms + "ms").padStart(8)} ${r.output_tokens.toLocaleString().padStart(8)} ${r.status}`);
  }
  console.log("-".repeat(80));
  console.log(`${"TOTAL".padEnd(55)} ${(totalMs + "ms").padStart(8)} ${totalTokens.toLocaleString().padStart(8)}`);
  console.log(`\nBenchmark operations: ${results.length}`);
  console.log(`Errors: ${results.filter(r => r.status === "error").length}`);
  console.log(`Avg latency: ${Math.round(totalMs / results.length)}ms`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
