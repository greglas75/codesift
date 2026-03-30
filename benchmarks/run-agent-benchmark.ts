#!/usr/bin/env npx tsx
/**
 * CodeSift Agent Task Benchmark (Layer 2)
 * ========================================
 *
 * Spawns fresh Claude agents for each task × method combination.
 * Measures: total_tokens (input+output), tool_calls, duration, cost.
 * Collects agent answers for scoring against gold expectations.
 *
 * Usage:
 *   npx tsx benchmarks/run-agent-benchmark.ts
 *   npx tsx benchmarks/run-agent-benchmark.ts --repo promptvault --method standard,codesift-bm25
 *   npx tsx benchmarks/run-agent-benchmark.ts --tasks T1,T2,T3 --method codesift-hybrid
 *   npx tsx benchmarks/run-agent-benchmark.ts --dry-run
 *   npx tsx benchmarks/run-agent-benchmark.ts --repo tgm-survey --method standard
 *
 * Requirements:
 *   - claude CLI installed and authenticated
 *   - MCP servers configured for codesift tools
 *   - Repos indexed in CodeSift
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { REAL_BENCHMARK_TASKS, STARTER_TASKS, type RealBenchmarkTask } from "./real-benchmark-tasks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = "sonnet"; // sonnet for benchmarks (fast, cheaper), opus for validation

interface RepoConfig {
  id: string;
  path: string;
  description: string;
  indexSize: string;
}

const REPOS: Record<string, RepoConfig> = {
  promptvault: {
    id: "promptvault",
    path: "/Users/greglas/DEV/Methodology Platform/promptvault",
    description: "Next.js 14+, TypeScript, Prisma",
    indexSize: "~4127 files, ~19K symbols",
  },
  "tgm-survey": {
    id: "tgm-survey",
    path: "/Users/greglas/DEV/tgm-survey-platform",
    description: "NestJS, TypeScript, Prisma, monorepo",
    indexSize: "~4080 files, ~60K symbols",
  },
  "translation-qa": {
    id: "translation-qa",
    path: "/Users/greglas/DEV/translation-qa",
    description: "AI translation pipeline, Qdrant, Vite",
    indexSize: "~778 files, ~4K symbols",
  },
};

// ---------------------------------------------------------------------------
// Methods — which tools each method is allowed to use
// ---------------------------------------------------------------------------

interface MethodConfig {
  id: string;
  description: string;
  allowedTools: string;
  promptPrefix: string;
}

const METHODS: Record<string, MethodConfig> = {
  standard: {
    id: "standard",
    description: "Built-in Claude Code tools only — baseline",
    allowedTools: "all",
    promptPrefix: "Using ONLY standard built-in tools: Read, Grep, Glob, and Bash. Do NOT use any mcp__codesift__ tools or other MCP tools",
  },
  "codesift-bm25": {
    id: "codesift-bm25",
    description: "CodeSift MCP tools (BM25 only, no semantic)",
    allowedTools: "all",
    promptPrefix:
      "Using ONLY mcp__codesift__ MCP tools for code search and navigation (NO Grep, NO Read of raw files, NO Bash — only CodeSift tools). Do NOT use semantic queries — only BM25/text/symbol search",
  },
  "codesift-hybrid": {
    id: "codesift-hybrid",
    description: "CodeSift MCP tools (BM25 + semantic)",
    allowedTools: "all",
    promptPrefix:
      "Using ONLY mcp__codesift__ MCP tools for code search and navigation (NO Grep, NO Read of raw files, NO Bash — only CodeSift tools). You MAY use semantic queries in codebase_retrieval",
  },
};

// ---------------------------------------------------------------------------
// Task definitions — T1-T18
// ---------------------------------------------------------------------------

interface Task {
  id: string;
  description: string;
  type: string;
  /** Gold criteria — must-include items for scoring */
  gold: string[];
  /** Acceptable partial — not perfect but still valid */
  partial: string[];
  /** What counts as failure */
  failureMode: string;
}

// ---------------------------------------------------------------------------
// Real-world tasks — extracted from actual conversation history
// ---------------------------------------------------------------------------
const REAL_TASKS: Task[] = [
  {
    id: "R1",
    description:
      "Jaki system authentykacji mamy w tym projekcie? Opisz flow logowania, jakie guards/middleware, gdzie przechowywany jest stan sesji. Czy możemy łatwo przejść na Clerk?",
    type: "architecture_understanding",
    gold: [
      "identifies auth guard/middleware",
      "describes login flow",
      "session/token storage mechanism",
      "assessment of Clerk migration feasibility",
    ],
    partial: ["auth guard found but incomplete flow"],
    failureMode: "vague description without code evidence",
  },
  {
    id: "R2",
    description:
      "Czy mamy wyciągnięte wszystkie hardcoded values do tłumaczenia interfejsu? Znajdź hardcoded stringi w komponentach UI które powinny być przetłumaczone.",
    type: "cross_cutting_search",
    gold: [
      "list of files with hardcoded UI strings",
      "examples of untranslated text",
      "assessment of i18n coverage",
    ],
    partial: ["some files found but incomplete scan"],
    failureMode: "only checks one directory or guesses",
  },
  {
    id: "R3",
    description:
      "Przeanalizuj kliki w kampaniach — znajdź gdzie logujemy click events, jak trackujemy konwersje, i czy dane z kampanii trafiają do logów w Mobi lub Shield.",
    type: "cross_system_trace",
    gold: [
      "click tracking implementation",
      "conversion tracking flow",
      "integration points with external systems",
    ],
    partial: ["tracking code found but integration unclear"],
    failureMode: "no concrete code paths found",
  },
  {
    id: "R4",
    description:
      "Napisz pełną dokumentację API tego projektu — wszystkie endpointy, metody HTTP, parametry, response shapes, auth requirements.",
    type: "full_api_documentation",
    gold: [
      "complete endpoint list",
      "HTTP methods and paths",
      "request/response schemas",
      "auth requirements per endpoint",
    ],
    partial: ["most endpoints but missing schemas"],
    failureMode: "incomplete endpoint list or invented endpoints",
  },
  {
    id: "R5",
    description:
      "Sprawdź czy mamy jakieś niezmergowane worktrees i branche. Przeanalizuj co jest w nich — czy to WIP czy abandoned. Daj rekomendację co zmergować a co usunąć.",
    type: "git_analysis",
    gold: [
      "list of active branches/worktrees",
      "content summary of each",
      "merge/delete recommendation",
    ],
    partial: ["branch list without analysis"],
    failureMode: "only checks one source (branches or worktrees, not both)",
  },
];

const PROMPTVAULT_TASKS: Task[] = [
  {
    id: "T1",
    description:
      "Find `createRisk` definition — full function signature, all parameters with types, and return type",
    type: "find_function",
    gold: [
      "correct function definition",
      "params with types",
      "return type",
      "real file path",
    ],
    partial: ["correct function + partial signature"],
    failureMode: "usage site only, wrong file, missing function definition",
  },
  {
    id: "T2",
    description:
      "Find ALL files that import from the risk service (both production code and test files)",
    type: "find_usages",
    gold: [
      "full importer set",
      "production imports",
      "routes/pages that use risk service",
    ],
    partial: ["most prod imports, tests optional"],
    failureMode: "only top few imports, misses key prod importers",
  },
  {
    id: "T3",
    description:
      "Find `DocumentDetail` type — list ALL fields including nested types",
    type: "understand_type",
    gold: [
      "all fields",
      "includes legalEntity if present",
      "correct file path",
    ],
    partial: ["most fields, one minor omission"],
    failureMode: "wrong type or incomplete field list",
  },
  {
    id: "T4",
    description:
      "Trace `withAuth` middleware logic — how does it work, what does it check, what does it wrap?",
    type: "trace_middleware",
    gold: [
      "HOF chain",
      "session extraction",
      "auth flow",
      "key wrapper behavior",
    ],
    partial: ["session extraction + wrapper chain but missing one detail"],
    failureMode: "just grep hits with no logic trace",
  },
  {
    id: "T5",
    description:
      "Find all Zod schemas used in API routes — list schema names and their file paths",
    type: "find_pattern",
    gold: ["schema names", "file paths for API route validation"],
    partial: ["most major schemas with paths"],
    failureMode: "only general mention of Zod, no concrete files",
  },
  {
    id: "T6",
    description:
      "Analyze `RiskPanel` component — what are its props, which hooks does it use, key dependencies?",
    type: "component_analysis",
    gold: [
      "props interface",
      "main hooks used",
      "key dependencies",
    ],
    partial: ["props or hooks mostly right but incomplete"],
    failureMode: "generic component summary without code grounding",
  },
  {
    id: "T7",
    description:
      "Find `ENTITY_NOT_FOUND` error — where is it defined and where is it thrown/used?",
    type: "error_codes",
    gold: ["definition site", "throw/use sites"],
    partial: ["definition + most references"],
    failureMode: "only definition or only one use site",
  },
  {
    id: "T8",
    description:
      "List all risk-related API routes with their HTTP methods (GET, POST, PATCH, DELETE)",
    type: "api_routes",
    gold: ["full route list with methods"],
    partial: ["mostly complete route list"],
    failureMode: "missing multiple routes or methods",
  },
  {
    id: "T9",
    description:
      "Find all `prisma.$transaction` usages — list each file and the surrounding context",
    type: "cross_cutting",
    gold: ["all transaction sites", "file context"],
    partial: ["all files, limited surrounding context"],
    failureMode: "misses one or more production sites",
  },
  {
    id: "T10",
    description:
      "Trace the document analysis pipeline architecture: upload → parse → AI analysis → risk creation",
    type: "architecture_trace",
    gold: [
      "upload stage",
      "parse stage",
      "AI analysis stage",
      "risk creation stage",
      "key services/modules for each",
    ],
    partial: ["three of four stages correct"],
    failureMode: "vague description with no concrete modules",
  },
  {
    id: "T11",
    description:
      "Find dead/unused exports in `src/lib/services` — exported symbols with zero external references",
    type: "dead_code",
    gold: [
      "exported symbols with zero external refs",
      "evidence (no importers found)",
    ],
    partial: ["strong candidates with caveats"],
    failureMode: "hallucinated dead code without evidence",
  },
  {
    id: "T12",
    description:
      "Find the top 5 most complex functions in the codebase — name, file, complexity indicators",
    type: "complexity",
    gold: [
      "function names",
      "file paths",
      "complexity indicators (lines, nesting, cyclomatic)",
    ],
    partial: ["good candidates with rough ranking"],
    failureMode: "no evidence or obviously wrong top set",
  },
  {
    id: "T13",
    description:
      "Check for circular dependencies in `src/lib/services` — list any cycles or confirm acyclic",
    type: "circular_deps",
    gold: ["real cycles or clear acyclic confirmation with evidence"],
    partial: ["partial cycle candidate list"],
    failureMode: "unverified claim of cycles",
  },
  {
    id: "T14",
    description:
      "Generate a Mermaid diagram of `analyzeDocument` callees to depth 2",
    type: "visualization",
    gold: ["valid Mermaid syntax", "correct key callees"],
    partial: ["rough diagram with mostly correct nodes"],
    failureMode: "invalid diagram or wrong call graph",
  },
  {
    id: "T15",
    description:
      "Find code clones (>70% similarity) in `src/lib/services` — pairs of similar functions",
    type: "clone_detection",
    gold: ["real clone pairs", "reason for similarity"],
    partial: ["good candidate pairs without score"],
    failureMode: "generic similar-looking code with no proof",
  },
  {
    id: "T16",
    description:
      "Find git churn hotspots in the last 90 days — most frequently changed files",
    type: "hotspot_analysis",
    gold: ["top changed files", "hotspot interpretation"],
    partial: ["good churn list without complexity synthesis"],
    failureMode: "no git basis, random files",
  },
  {
    id: "T17",
    description:
      "Search for the `empty-catch` anti-pattern — catch blocks with empty bodies",
    type: "pattern_search",
    gold: ["files/functions with empty catch blocks"],
    partial: ["correct near-misses noted carefully"],
    failureMode: "claims empty catches where none exist",
  },
  {
    id: "T18",
    description:
      "Get the full context bundle for `createRisk` — symbol source, imports, sibling functions, types used",
    type: "context_bundle",
    gold: [
      "symbol source code",
      "file imports",
      "sibling context",
      "types used",
    ],
    partial: ["strong symbol body + partial context bundle"],
    failureMode: "only raw function body",
  },
];

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

interface AgentResult {
  taskId: string;
  method: string;
  repo: string;
  // From claude JSON output
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  // Extracted from agent answer
  answer: string;
  // Scoring (filled by scorer)
  correctness: number;
  completeness: number;
  confidence: string;
  pass: boolean;
}

function buildPrompt(task: Task, method: MethodConfig, _repo: RepoConfig): string {
  return `${method.promptPrefix}.

${task.description}`;
}

async function runAgent(
  task: Task,
  method: MethodConfig,
  repo: RepoConfig,
): Promise<AgentResult> {
  const prompt = buildPrompt(task, method, repo);

  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--no-session-persistence",
      "--model", MODEL,
      "--permission-mode", "bypassPermissions",
      ...(method.allowedTools !== "all" ? ["--allowedTools", method.allowedTools] : []),
      prompt,
    ];

    const proc = spawn("claude", args, {
      cwd: repo.path,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 300_000, // 5 min max per task
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      let result: AgentResult = {
        taskId: task.id,
        method: method.id,
        repo: repo.id,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        numTurns: 0,
        answer: "",
        correctness: 0,
        completeness: 0,
        confidence: "LOW",
        pass: false,
      };

      try {
        const json = JSON.parse(stdout);
        const usage = json.usage || {};

        result.durationMs = json.duration_ms || 0;
        result.inputTokens = usage.input_tokens || 0;
        result.outputTokens = usage.output_tokens || 0;
        result.cacheReadTokens = usage.cache_read_input_tokens || 0;
        result.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        result.totalTokens = result.inputTokens + result.outputTokens;
        result.costUsd = json.total_cost_usd || 0;
        result.numTurns = json.num_turns || 0;
        result.answer = json.result || "";

        // Extract structured report from answer
        const reportMatch = result.answer.match(
          /BENCHMARK_REPORT_START\s*\n([\s\S]*?)BENCHMARK_REPORT_END/,
        );
        if (reportMatch) {
          const block = reportMatch[1];
          const confMatch = block.match(/confidence:\s*(HIGH|MEDIUM|LOW)/i);
          if (confMatch) result.confidence = confMatch[1].toUpperCase();
          const complMatch = block.match(/complete:\s*(Yes|Partial|No)/i);
          if (complMatch) {
            const val = complMatch[1].toLowerCase();
            result.completeness = val === "yes" ? 1.0 : val === "partial" ? 0.5 : 0.0;
          }
        } else {
          // Fallback: try unstructured parsing
          const confMatch = result.answer.match(/confidence:\s*(HIGH|MEDIUM|LOW)/i);
          if (confMatch) result.confidence = confMatch[1].toUpperCase();
          const complMatch = result.answer.match(/complete:\s*(Yes|Partial|No)/i);
          if (complMatch) {
            const val = complMatch[1].toLowerCase();
            result.completeness = val === "yes" ? 1.0 : val === "partial" ? 0.5 : 0.0;
          }
        }
      } catch {
        result.answer = `ERROR: ${stderr || stdout || `exit code ${code}`}`;
      }

      resolve(result);
    });

    proc.on("error", (err) => {
      resolve({
        taskId: task.id,
        method: method.id,
        repo: repo.id,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        numTurns: 0,
        answer: `SPAWN ERROR: ${err.message}`,
        correctness: 0,
        completeness: 0,
        confidence: "LOW",
        pass: false,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(
  results: AgentResult[],
  repoId: string,
): string {
  const timestamp = new Date().toISOString().slice(0, 16);
  const methods = [...new Set(results.map((r) => r.method))];

  let md = `# Agent Benchmark Report\n\n`;
  md += `**Date:** ${timestamp}\n`;
  md += `**Repo:** ${repoId}\n`;
  md += `**Model:** ${MODEL}\n`;
  md += `**Methods:** ${methods.join(", ")}\n\n`;

  // Summary table
  md += `## Summary by Method\n\n`;
  md += `| Method | Tasks | Input Tok | Output Tok | Total Tok | Cost | Avg Duration | Avg Turns |\n`;
  md += `|--------|-------|----------|-----------|----------|------|-------------|----------|\n`;

  for (const m of methods) {
    const mr = results.filter((r) => r.method === m);
    const totalIn = mr.reduce((s, r) => s + r.inputTokens, 0);
    const totalOut = mr.reduce((s, r) => s + r.outputTokens, 0);
    const totalTok = mr.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost = mr.reduce((s, r) => s + r.costUsd, 0);
    const totalDur = mr.reduce((s, r) => s + r.durationMs, 0);
    const avgDur = Math.round(totalDur / mr.length);
    const avgTurns = (mr.reduce((s, r) => s + r.numTurns, 0) / mr.length).toFixed(1);
    md += `| **${m}** | ${mr.length} | ${totalIn.toLocaleString()} | ${totalOut.toLocaleString()} | ${totalTok.toLocaleString()} | $${totalCost.toFixed(2)} | ${(avgDur / 1000).toFixed(1)}s | ${avgTurns} |\n`;
  }
  md += "\n";

  // Per-task comparison: Tokens (input | output | total per method)
  const tasks = [...new Set(results.map((r) => r.taskId))].sort();

  md += `## Tokens per Task\n\n`;
  md += `| Task |`;
  for (const m of methods) {
    md += ` ${m} in | ${m} out | ${m} total |`;
  }
  if (methods.length >= 2) md += ` Delta |`;
  md += "\n";
  md += `|------|`;
  for (const _m of methods) {
    md += `------:|------:|------:|`;
  }
  if (methods.length >= 2) md += `------:|`;
  md += "\n";

  const totalsIn: Record<string, number> = {};
  const totalsOut: Record<string, number> = {};
  const totalsAll: Record<string, number> = {};

  for (const t of tasks) {
    let row = `| ${t} `;
    const taskTotals: Record<string, number> = {};
    for (const m of methods) {
      const r = results.find((r) => r.taskId === t && r.method === m);
      const inp = r?.inputTokens ?? 0;
      const out = r?.outputTokens ?? 0;
      const tot = r?.totalTokens ?? 0;
      taskTotals[m] = tot;
      totalsIn[m] = (totalsIn[m] || 0) + inp;
      totalsOut[m] = (totalsOut[m] || 0) + out;
      totalsAll[m] = (totalsAll[m] || 0) + tot;
      row += `| ${inp.toLocaleString()} | ${out.toLocaleString()} | ${tot.toLocaleString()} `;
    }
    if (methods.length >= 2) {
      const baseline = taskTotals[methods[0]]!;
      const challenger = taskTotals[methods[1]]!;
      if (baseline > 0) {
        const delta = ((challenger - baseline) / baseline) * 100;
        const marker = delta < 0 ? "**" : "";
        row += `| ${marker}${delta > 0 ? "+" : ""}${delta.toFixed(0)}%${marker} `;
      } else {
        row += "| — ";
      }
    }
    row += "|\n";
    md += row;
  }

  // Totals row
  let totalRow = `| **TOTAL** `;
  for (const m of methods) {
    totalRow += `| **${(totalsIn[m] || 0).toLocaleString()}** | **${(totalsOut[m] || 0).toLocaleString()}** | **${(totalsAll[m] || 0).toLocaleString()}** `;
  }
  if (methods.length >= 2) {
    const bl = totalsAll[methods[0]]!;
    const ch = totalsAll[methods[1]]!;
    if (bl > 0) {
      const d = ((ch - bl) / bl) * 100;
      const mk = d < 0 ? "**" : "";
      totalRow += `| ${mk}${d > 0 ? "+" : ""}${d.toFixed(0)}%${mk} `;
    }
  }
  totalRow += "|\n";
  md += totalRow;
  md += "\n";

  // Per-task comparison: Duration
  md += `## Duration per Task (seconds)\n\n`;
  md += `| Task | ${methods.join(" | ")} |\n`;
  md += `|------|${methods.map(() => "------").join("|")}|\n`;
  for (const t of tasks) {
    let row = `| ${t} `;
    for (const m of methods) {
      const r = results.find((r) => r.taskId === t && r.method === m);
      row += `| ${((r?.durationMs ?? 0) / 1000).toFixed(1)}s `;
    }
    row += "|\n";
    md += row;
  }
  md += "\n";

  // Per-task: Tool calls (turns)
  md += `## Tool Calls per Task\n\n`;
  md += `| Task | ${methods.join(" | ")} |\n`;
  md += `|------|${methods.map(() => "------").join("|")}|\n`;
  for (const t of tasks) {
    let row = `| ${t} `;
    for (const m of methods) {
      const r = results.find((r) => r.taskId === t && r.method === m);
      row += `| ${r?.numTurns ?? 0} `;
    }
    row += "|\n";
    md += row;
  }
  md += "\n";

  // Confidence & Completeness
  md += `## Confidence & Completeness\n\n`;
  md += `| Task |`;
  for (const m of methods) {
    md += ` ${m} conf | ${m} complete |`;
  }
  md += "\n";
  md += `|------|`;
  for (const _m of methods) {
    md += `------|---------|`;
  }
  md += "\n";
  for (const t of tasks) {
    let row = `| ${t} `;
    for (const m of methods) {
      const r = results.find((r) => r.taskId === t && r.method === m);
      const comp = r?.completeness === 1.0 ? "Yes" : r?.completeness === 0.5 ? "Partial" : "No";
      row += `| ${r?.confidence ?? "—"} | ${comp} `;
    }
    row += "|\n";
    md += row;
  }

  return md;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  const dryRun = hasFlag("dry-run");
  const repoId = getArg("repo") || "promptvault";
  const methodIds = (getArg("method") || "standard,codesift-bm25").split(",");
  const taskFilter = getArg("tasks")?.split(",");

  const repo = REPOS[repoId];
  if (!repo) {
    console.error(`Unknown repo: ${repoId}. Available: ${Object.keys(REPOS).join(", ")}`);
    process.exit(1);
  }

  const selectedMethods = methodIds.map((id) => {
    const m = METHODS[id];
    if (!m) {
      console.error(`Unknown method: ${id}. Available: ${Object.keys(METHODS).join(", ")}`);
      process.exit(1);
    }
    return m;
  });

  const useReal = hasFlag("real") || hasFlag("starter");
  const useStarter = hasFlag("starter");

  // Select tasks
  let tasks: Task[];
  if (useReal || useStarter) {
    // Real benchmark mode — map RealBenchmarkTask to Task
    const realTasks = useStarter ? STARTER_TASKS : REAL_BENCHMARK_TASKS;
    const filtered = taskFilter
      ? realTasks.filter((t) => taskFilter.includes(t.id))
      : realTasks;

    // Override repo per-task (real tasks specify their own repo)
    // We'll handle this in the run loop
    tasks = filtered.map((rt) => ({
      id: rt.id,
      description: rt.userAsk,
      type: rt.title,
      gold: [],
      partial: [],
      failureMode: "",
      _repo: rt.repo,
    } as Task & { _repo?: string }));
  } else if (taskFilter && taskFilter.some((t) => t.startsWith("R"))) {
    tasks = REAL_TASKS.filter((t) => taskFilter.includes(t.id));
  } else {
    tasks = taskFilter
      ? PROMPTVAULT_TASKS.filter((t) => taskFilter.includes(t.id))
      : PROMPTVAULT_TASKS;
  }

  const totalRuns = tasks.length * selectedMethods.length;

  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║           CodeSift Agent Task Benchmark (Layer 2)            ║");
  console.log("╠═══════════════════════════════════════════════════════════════╣");
  console.log(`║  Repo:    ${repo.id.padEnd(52)}║`);
  console.log(`║  Methods: ${methodIds.join(", ").padEnd(52)}║`);
  console.log(`║  Tasks:   ${String(tasks.length).padEnd(52)}║`);
  console.log(`║  Runs:    ${String(totalRuns).padEnd(52)}║`);
  console.log(`║  Model:   ${MODEL.padEnd(52)}║`);
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log();

  if (dryRun) {
    console.log("DRY RUN — would execute:\n");
    for (const method of selectedMethods) {
      for (const task of tasks) {
        console.log(`  ${task.id} × ${method.id}: ${task.description.slice(0, 60)}...`);
      }
    }
    console.log(`\nTotal: ${totalRuns} agent runs`);
    return;
  }

  // Build all runs
  const runs: Array<{ task: Task; method: MethodConfig; repo: RepoConfig }> = [];
  for (const method of selectedMethods) {
    for (const task of tasks) {
      const taskRepo = (task as Task & { _repo?: string })._repo
        ? REPOS[(task as Task & { _repo?: string })._repo!] ?? repo
        : repo;
      runs.push({ task, method, repo: taskRepo });
    }
  }

  // Run ALL agents in parallel (like real life)
  console.log(`\nLaunching ${runs.length} agents in parallel...\n`);

  const promises = runs.map((run) =>
    runAgent(run.task, run.method, run.repo),
  );

  const results = await Promise.all(promises);

  // Print results sorted by method then task
  for (const method of selectedMethods) {
    console.log(`\n━━━ Method: ${method.id} (${method.description}) ━━━\n`);
    const methodResults = results.filter((r) => r.method === method.id);
    for (const result of methodResults) {
      const status = result.answer.startsWith("ERROR") ? "ERR" : "OK ";
      const comp = result.completeness === 1.0 ? "Yes" : result.completeness === 0.5 ? "Partial" : "No";
      const taskRepo = runs.find(
        (r) => r.task.id === result.taskId && r.method.id === result.method,
      )?.repo;
      console.log(
        `  ${result.taskId} [${taskRepo?.id ?? "?"}] ` +
          `${status}  ` +
          `in=${String(result.inputTokens).padStart(5)} ` +
          `out=${String(result.outputTokens).padStart(5)} ` +
          `tot=${String(result.totalTokens).padStart(6)}  ` +
          `${(result.durationMs / 1000).toFixed(1).padStart(5)}s  ` +
          `${String(result.numTurns).padStart(2)}t  ` +
          `$${result.costUsd.toFixed(2)}  ` +
          `${result.confidence}/${comp}`,
      );
    }
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultsDir = path.join(__dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  // JSON (full data for scoring)
  const jsonPath = path.join(resultsDir, `agent-${repoId}-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${jsonPath}`);

  // Markdown report
  const report = generateReport(results, repoId);
  const mdPath = path.join(resultsDir, `agent-${repoId}-${timestamp}.md`);
  fs.writeFileSync(mdPath, report);
  console.log(`Report:  ${mdPath}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  for (const m of selectedMethods) {
    const mr = results.filter((r) => r.method === m.id);
    const totalTok = mr.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost = mr.reduce((s, r) => s + r.costUsd, 0);
    console.log(
      `  ${m.id.padEnd(20)} ${totalTok.toLocaleString().padStart(8)} tok  $${totalCost.toFixed(2)}`,
    );
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
