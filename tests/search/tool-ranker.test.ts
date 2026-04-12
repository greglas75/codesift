import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  rankTools,
  generateReasoning,
  buildToolBM25Index,
  toolDefsFingerprint,
  clearToolBM25Cache,
  getToolEmbeddings,
  getToolEmbeddingCachePath,
  type ToolRankerContext,
  type ToolRecommendation,
} from "../../src/search/tool-ranker.js";
// NOTE: register-tools.js currently has a broken transitive import
// (./tools/constant-resolution-tools.js is missing on disk), so we only
// take the *type* from it and build synthetic ToolDefinition fixtures
// locally. This keeps the tool-ranker tests hermetic and fast.
import type { ToolDefinition } from "../../src/register-tools.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDef(
  name: string,
  description: string,
  searchHint = "",
  category: ToolDefinition["category"] = "search",
): ToolDefinition {
  return {
    name,
    description,
    searchHint,
    category,
    schema: { _: z.string().optional() },
    handler: async () => "",
  };
}

const FIXTURE_DEFS: ToolDefinition[] = [
  makeDef("find_dead_code", "Find unused exported symbols and dead code in a repo", "dead unused exports pruning", "analysis"),
  makeDef("search_text", "Search for text patterns across source files", "grep regex content search", "search"),
  makeDef("search_symbols", "Search symbols (functions, classes, types) by name", "find symbol name definition", "search"),
  makeDef("analyze_complexity", "Report cyclomatic complexity for top functions", "complexity cyclomatic refactor", "analysis"),
  makeDef("detect_communities", "Detect strongly-connected code modules via import graph", "modules clusters communities architecture", "architecture"),
  makeDef("scan_secrets", "Scan for leaked secrets and API keys in the codebase", "secrets keys credentials security", "security"),
  makeDef("trace_route", "Trace an HTTP route from handler to middleware chain", "endpoint route http middleware", "graph"),
  makeDef("analyze_hotspots", "Analyze git churn and hotspots via blame history", "churn git hotspot blame", "analysis"),
  makeDef("find_clones", "Find duplicated code blocks across the repo", "duplicate clone dry copy-paste", "patterns"),
  makeDef("impact_analysis", "Compute blast radius of changes since a git revision", "blast radius impact changes git diff", "diff"),
];

function makeCtx(overrides: Partial<ToolRankerContext> & { query: string }): ToolRankerContext {
  return {
    toolDefs: FIXTURE_DEFS,
    embeddings: null,
    queryEmbedding: null,
    usageFrequency: new Map(),
    frameworkTools: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearToolBM25Cache();
});

// ---------------------------------------------------------------------------
// Task 1 — BM25 adapter + fingerprint cache
// ---------------------------------------------------------------------------

describe("toolDefsFingerprint", () => {
  it("returns a stable 16-char hex fingerprint", () => {
    const fp = toolDefsFingerprint(FIXTURE_DEFS);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it("is stable across calls", () => {
    const a = toolDefsFingerprint(FIXTURE_DEFS);
    const b = toolDefsFingerprint([...FIXTURE_DEFS]);
    expect(a).toBe(b);
  });

  it("changes when descriptions change", () => {
    const fpA = toolDefsFingerprint(FIXTURE_DEFS);
    const modified = FIXTURE_DEFS.map((d, i) =>
      i === 0 ? { ...d, description: "totally different purpose" } : d,
    );
    const fpB = toolDefsFingerprint(modified);
    expect(fpA).not.toBe(fpB);
  });
});

describe("buildToolBM25Index", () => {
  it("indexes every tool definition", () => {
    const index = buildToolBM25Index(FIXTURE_DEFS);
    expect(index.docCount).toBe(FIXTURE_DEFS.length);
    for (const d of FIXTURE_DEFS) {
      expect(index.symbols.has(d.name)).toBe(true);
    }
  });

  it("reuses the cached index when fingerprint matches", () => {
    const a = buildToolBM25Index(FIXTURE_DEFS);
    const b = buildToolBM25Index(FIXTURE_DEFS);
    expect(b).toBe(a); // object identity — cache hit
  });

  it("rebuilds when defs are mutated", () => {
    const a = buildToolBM25Index(FIXTURE_DEFS);
    const next = [...FIXTURE_DEFS, makeDef("new_tool", "a brand new inserted tool", "novel")];
    const b = buildToolBM25Index(next);
    expect(b).not.toBe(a);
    expect(b.docCount).toBe(a.docCount + 1);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Lexical + identity signals
// ---------------------------------------------------------------------------

describe("rankTools — lexical signal", () => {
  it("returns at most 10 recommendations", () => {
    const ctx = makeCtx({ query: "find unused code" });
    const recs = rankTools(ctx);
    expect(recs.length).toBeLessThanOrEqual(10);
  });

  it("ranks find_dead_code first for 'unused exported symbols'", () => {
    const ctx = makeCtx({ query: "unused exported symbols" });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("find_dead_code");
  });

  it("ranks search_text first for 'grep for pattern in files'", () => {
    const ctx = makeCtx({ query: "grep for pattern in files" });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("search_text");
  });

  it("returns empty list for empty query", () => {
    const ctx = makeCtx({ query: "" });
    expect(rankTools(ctx)).toEqual([]);
  });

  it("returns empty list when no tool defs supplied", () => {
    const ctx = makeCtx({ query: "anything", toolDefs: [] });
    expect(rankTools(ctx)).toEqual([]);
  });
});

describe("rankTools — identity signal", () => {
  it("identity match beats pure lexical", () => {
    // "trace_route" is present verbatim → identity=1 → dominates
    const ctx = makeCtx({ query: "I want to trace_route for my handler" });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("trace_route");
  });

  it("identity match handles spaced variant of snake_case", () => {
    const ctx = makeCtx({ query: "please find dead code in the repo" });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("find_dead_code");
    // Reasoning should mention exact name match.
    expect(recs[0]?.reasoning.toLowerCase()).toContain("exact name match");
  });

  it("populates is_hidden field based on coreToolNames ctx", () => {
    const core = new Set(["search_text", "search_symbols"]);
    const ctx = makeCtx({ query: "search text", coreToolNames: core });
    const recs = rankTools(ctx);
    expect(recs.length).toBeGreaterThan(0);
    const searchText = recs.find((r) => r.name === "search_text");
    const findDead = recs.find((r) => r.name === "find_dead_code");
    if (searchText) expect(searchText.is_hidden).toBe(false);
    if (findDead) expect(findDead.is_hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — Semantic, structural, framework, calibration
// ---------------------------------------------------------------------------

describe("rankTools — semantic signal", () => {
  it("uses embeddings to rank when lexical is weak", () => {
    // Contrived query that would not lex-match "detect_communities" but
    // whose fake embedding is nearly identical.
    const qvec = [1, 0, 0, 0];
    const embeddings = new Map<string, number[]>([
      ["detect_communities", [0.99, 0.01, 0, 0]],
      ["search_text", [0, 1, 0, 0]],
      ["scan_secrets", [0, 0, 1, 0]],
      ["find_dead_code", [0, 0, 0, 1]],
    ]);

    const ctx = makeCtx({
      query: "give me big clusters of tightly coupled modules",
      embeddings,
      queryEmbedding: qvec,
    });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("detect_communities");
  });

  it("gracefully degrades when embeddings are null", () => {
    const ctx = makeCtx({ query: "find unused exported symbols" });
    const recs = rankTools(ctx);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]?.name).toBe("find_dead_code");
  });
});

describe("rankTools — structural signal", () => {
  it("usage frequency breaks ties among lexically identical tools", () => {
    // Two tools with IDENTICAL description + searchHint → same BM25 score.
    // Usage frequency must then decide the ordering.
    const twinDefs: ToolDefinition[] = [
      makeDef("twin_alpha", "perform a shared generic action on the repo", "shared generic action"),
      makeDef("twin_bravo", "perform a shared generic action on the repo", "shared generic action"),
    ];
    const usage = new Map<string, number>([
      ["twin_alpha", 1],
      ["twin_bravo", 100],
    ]);
    const ctx = makeCtx({
      query: "perform a shared generic action",
      toolDefs: twinDefs,
      usageFrequency: usage,
    });
    const recs = rankTools(ctx);
    expect(recs[0]?.name).toBe("twin_bravo");
  });
});

describe("rankTools — framework signal", () => {
  it("framework tools get a meaningful boost", () => {
    const ctx = makeCtx({
      query: "search text",
      frameworkTools: ["trace_route"],
    });
    const recs = rankTools(ctx);
    const names = recs.map((r) => r.name);
    expect(names).toContain("trace_route");
  });
});

describe("rankTools — confidence calibration", () => {
  it("vague query caps confidence at 0.5", () => {
    const ctx = makeCtx({ query: "help me" });
    const recs = rankTools(ctx);
    for (const r of recs) {
      expect(r.confidence).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("single-keyword query caps confidence at 0.6", () => {
    const ctx = makeCtx({ query: "complexity" });
    const recs = rankTools(ctx);
    for (const r of recs) {
      expect(r.confidence).toBeLessThanOrEqual(0.6 + 1e-9);
    }
  });

  it("clear, multi-word query can reach confidence 1.0", () => {
    const ctx = makeCtx({ query: "find unused exported dead code symbols" });
    const recs = rankTools(ctx);
    expect(recs[0]?.confidence).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// Task 4 — Reasoning templates
// ---------------------------------------------------------------------------

describe("generateReasoning", () => {
  it("mentions exact name match when identity signal is present", () => {
    const out = generateReasoning("find_dead_code", "find dead code please", {
      lexical: 0.8,
      identity: 1,
      semantic: 0,
      structural: 0,
      framework: 0,
      lexicalTokens: ["dead", "code"],
    });
    expect(out).toContain("exact name match");
  });

  it("mentions keyword list when only lexical fires", () => {
    const out = generateReasoning("search_text", "grep the codebase", {
      lexical: 0.5,
      identity: 0,
      semantic: 0,
      structural: 0,
      framework: 0,
      lexicalTokens: ["grep"],
    });
    expect(out).toContain("keywords");
    expect(out).toContain("grep");
  });

  it("mentions semantic similarity when semantic signal dominates", () => {
    const out = generateReasoning("detect_communities", "clusters", {
      lexical: 0,
      identity: 0,
      semantic: 0.85,
      structural: 0,
      framework: 0,
      lexicalTokens: [],
    });
    expect(out).toContain("semantic similarity");
  });

  it("mentions usage frequency when structural fires", () => {
    const out = generateReasoning("search_text", "search", {
      lexical: 0,
      identity: 0,
      semantic: 0,
      structural: 0.9,
      framework: 0,
      lexicalTokens: [],
    });
    expect(out).toContain("usage frequency");
  });

  it("mentions framework stack when framework signal fires", () => {
    const out = generateReasoning("trace_route", "what now", {
      lexical: 0,
      identity: 0,
      semantic: 0,
      structural: 0,
      framework: 1,
      lexicalTokens: [],
    });
    expect(out).toContain("stack");
  });

  it("falls back to a generic phrase when no signal dominates", () => {
    const out = generateReasoning("foo", "quiet query", {
      lexical: 0,
      identity: 0,
      semantic: 0,
      structural: 0,
      framework: 0,
      lexicalTokens: [],
    });
    expect(out.toLowerCase()).toContain("general match");
  });
});

// ---------------------------------------------------------------------------
// Task 5 — Tool-embedding cache + offline fallback
// ---------------------------------------------------------------------------

describe("getToolEmbeddings", () => {
  it("returns null when no embedding provider is configured", async () => {
    // Stash env vars so we run offline regardless of host setup.
    const saved = {
      VOYAGE: process.env["CODESIFT_VOYAGE_API_KEY"],
      OPENAI: process.env["CODESIFT_OPENAI_API_KEY"],
      OLLAMA: process.env["CODESIFT_OLLAMA_URL"],
    };
    delete process.env["CODESIFT_VOYAGE_API_KEY"];
    delete process.env["CODESIFT_OPENAI_API_KEY"];
    delete process.env["CODESIFT_OLLAMA_URL"];

    // Bust the cached config singleton.
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();

    try {
      const result = await getToolEmbeddings(FIXTURE_DEFS);
      expect(result).toBeNull();
    } finally {
      if (saved.VOYAGE !== undefined) process.env["CODESIFT_VOYAGE_API_KEY"] = saved.VOYAGE;
      if (saved.OPENAI !== undefined) process.env["CODESIFT_OPENAI_API_KEY"] = saved.OPENAI;
      if (saved.OLLAMA !== undefined) process.env["CODESIFT_OLLAMA_URL"] = saved.OLLAMA;
      resetConfigCache();
    }
  });

  it("exposes an absolute cache path under ~/.codesift", () => {
    const p = getToolEmbeddingCachePath();
    expect(p).toContain(".codesift");
    expect(p.endsWith("tool-embeddings.ndjson")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Smoke benchmark (Task 5 closure) — Recall@5 ≥ 0.6, cold latency < 2s.
// Uses a synthetic ~50-tool catalog modeled after the real tool set so we
// get meaningful ranking signal without depending on register-tools.ts at
// runtime (which currently has a broken transitive import).
// ---------------------------------------------------------------------------

const SMOKE_CATALOG: ToolDefinition[] = [
  // Targets
  makeDef("find_dead_code", "Find unused exported symbols and dead code in a repo", "dead unused exports pruning", "analysis"),
  makeDef("search_text", "Search for text patterns across source files with regex support", "grep regex content search text pattern", "search"),
  makeDef("analyze_complexity", "Report cyclomatic complexity scores for top functions", "cyclomatic complexity refactor measure", "analysis"),
  makeDef("detect_communities", "Detect strongly connected module communities via import graph", "modules clusters communities graph architecture", "architecture"),
  makeDef("scan_secrets", "Scan for leaked API keys, tokens, and secrets in the codebase", "secrets keys credentials tokens security", "security"),

  // Distractors — search family
  makeDef("search_symbols", "Search indexed symbols by name, kind, and file pattern", "symbol name function class type", "search"),
  makeDef("search_patterns", "Search structural code anti-patterns like empty catches", "anti pattern antipattern empty catch", "patterns"),
  makeDef("search_conversations", "Search past Claude conversation transcripts", "conversation history past sessions", "conversations"),
  makeDef("semantic_search", "Embedding-based semantic similarity search over symbols", "semantic embedding similarity meaning", "search"),
  makeDef("cross_repo_search", "Search symbols across multiple indexed repos", "cross repository multi repo", "cross-repo"),

  // Distractors — outline / file tree
  makeDef("get_file_outline", "Return the outline of symbols in a single file", "file outline summary structure", "outline"),
  makeDef("get_file_tree", "Return a nested tree of files and their symbol counts", "file tree directory listing", "outline"),
  makeDef("get_repo_outline", "Return a high-level outline of the whole repository", "repo repository outline overview", "outline"),
  makeDef("suggest_queries", "Suggest useful exploratory queries for a new repo", "suggest explore new repo onboarding", "outline"),

  // Distractors — symbols
  makeDef("get_symbol", "Return the source code of a single symbol by id or name", "read symbol source fetch", "symbols"),
  makeDef("get_symbols", "Batch-read multiple symbols in one call", "batch symbols many multiple", "symbols"),
  makeDef("find_references", "Find references and usages of a given symbol", "references usages find callers", "symbols"),
  makeDef("find_and_show", "Find a symbol and show it along with its references", "find show symbol refs", "symbols"),
  makeDef("get_context_bundle", "Return a symbol plus its surrounding dependency context", "context bundle symbol deps", "symbols"),

  // Distractors — graph / trace
  makeDef("trace_call_chain", "Trace a call chain from a symbol through callers or callees", "call chain tree stack trace", "graph"),
  makeDef("trace_route", "Trace an HTTP route through middleware to its handler", "http route endpoint middleware express fastapi", "graph"),
  makeDef("trace_middleware_chain", "Trace Hono middleware chain for a route", "hono middleware chain", "graph"),
  makeDef("impact_analysis", "Compute the blast radius of recent changes", "blast radius impact changes git diff", "diff"),

  // Distractors — analysis
  makeDef("analyze_hotspots", "Analyze git churn and file hotspots over time", "churn git hotspot blame history", "analysis"),
  makeDef("analyze_project", "Return a high-level analysis profile for a project", "project profile stats", "analysis"),
  makeDef("find_clones", "Find duplicated code blocks across the repo", "duplicate clone dry copy paste", "patterns"),
  makeDef("analyze_hono_app", "Analyze a Hono web application", "hono web framework audit", "analysis"),
  makeDef("analyze_nextjs_components", "Classify Next.js components as server or client", "nextjs next server client component", "analysis"),

  // Distractors — indexing / meta
  makeDef("index_folder", "Index a local folder, extracting symbols into the search index", "index folder directory initial", "indexing"),
  makeDef("index_file", "Re-index a single file after an edit", "index file single edit", "indexing"),
  makeDef("list_repos", "List all indexed repositories", "list repos repositories", "indexing"),
  makeDef("discover_tools", "Keyword-search the full MCP tool catalog", "discover tools search tools find tool", "meta"),
  makeDef("describe_tools", "Return full schema and params for named tools", "describe tools schema params", "meta"),
  makeDef("usage_stats", "Return aggregated usage statistics for the MCP server", "usage stats stats statistics calls", "meta"),

  // Distractors — diff / context
  makeDef("diff_outline", "Return structural diff outline since a git revision", "diff outline git revision", "diff"),
  makeDef("changed_symbols", "List symbols changed since a git revision", "changed symbols git diff", "diff"),
  makeDef("review_diff", "Run multiple static checks across a git diff", "review diff pr checks", "diff"),
  makeDef("assemble_context", "Assemble dense context for a set of symbols", "context dense assemble gather", "context"),
  makeDef("codebase_retrieval", "Run a batch of retrieval queries over the index", "retrieval batch queries search", "context"),

  // Distractors — lsp / navigation
  makeDef("go_to_definition", "Jump to the definition of a symbol via LSP", "definition jump lsp goto", "lsp"),
  makeDef("get_type_info", "Return type information for a symbol via LSP", "type information lsp hover", "lsp"),
  makeDef("rename_symbol", "Rename a symbol across files via LSP", "rename symbol refactor cross file", "lsp"),
  makeDef("get_call_hierarchy", "Return incoming and outgoing calls for a symbol", "call hierarchy incoming outgoing", "lsp"),

  // Distractors — security / patterns
  makeDef("audit_scan", "One-call composite audit across quality gates", "audit scan quality gate", "analysis"),
  makeDef("nest_audit", "One-call NestJS analysis: modules, DI, guards, routes", "nestjs nest audit modules di", "nestjs"),
  makeDef("analyze_async_correctness", "Detect asyncio pitfalls in Python code", "python async asyncio pitfalls", "analysis"),
  makeDef("trace_celery_chain", "Trace Celery task chains and canvases", "celery task chain canvas", "graph"),

  // Distractors — conversation / memory
  makeDef("index_conversations", "Index Claude conversation transcripts", "conversation transcript index claude", "conversations"),
  makeDef("find_conversations_for_symbol", "Find conversations that reference a given symbol", "conversation symbol link", "conversations"),
];

interface SmokeQuery {
  query: string;
  expected: string;
}

const SMOKE_QUERIES: SmokeQuery[] = [
  { query: "find unused exported dead code symbols", expected: "find_dead_code" },
  { query: "grep text pattern across source files", expected: "search_text" },
  { query: "measure cyclomatic complexity of functions", expected: "analyze_complexity" },
  { query: "detect strongly connected module communities", expected: "detect_communities" },
  { query: "scan for leaked api keys and credentials", expected: "scan_secrets" },
];

describe("tool-ranker smoke benchmark", () => {
  it("Recall@5 >= 0.6 on synthetic catalog (cold latency < 2s)", () => {
    clearToolBM25Cache();
    const start = Date.now();

    let hits = 0;
    const misses: Array<{ query: string; expected: string; top5: string[] }> = [];

    for (const smoke of SMOKE_QUERIES) {
      const ctx: ToolRankerContext = {
        query: smoke.query,
        toolDefs: SMOKE_CATALOG,
        embeddings: null,
        queryEmbedding: null,
        usageFrequency: new Map(),
        frameworkTools: [],
      };
      const recs: ToolRecommendation[] = rankTools(ctx);
      const top5 = recs.slice(0, 5).map((r) => r.name);
      if (top5.includes(smoke.expected)) {
        hits++;
      } else {
        misses.push({ query: smoke.query, expected: smoke.expected, top5 });
      }
    }

    const elapsed = Date.now() - start;
    const recall = hits / SMOKE_QUERIES.length;

    if (recall < 0.6) {
      // eslint-disable-next-line no-console
      console.error("[smoke misses]", misses);
    }

    expect(elapsed).toBeLessThan(2000);
    expect(recall).toBeGreaterThanOrEqual(0.6);
  });
});
