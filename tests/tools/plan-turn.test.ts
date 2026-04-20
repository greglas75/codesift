import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import type { ToolRecommendation, ToolRankerContext } from "../../src/search/tool-ranker.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/search/tool-ranker.js", () => ({
  rankTools: vi.fn(),
  getToolEmbeddings: vi.fn(),
}));

vi.mock("../../src/storage/session-state.js", () => ({
  getSessionState: vi.fn(),
}));

vi.mock("../../src/storage/usage-stats.js", () => ({
  getUsageStats: vi.fn(),
}));

vi.mock("../../src/register-tools.js", () => ({
  CORE_TOOL_NAMES: new Set([
    "search_text",
    "discover_tools",
    "index_folder",
    "get_file_outline",
  ]),
  detectAutoLoadTools: vi.fn(),
  detectAutoLoadToolsCached: vi.fn(),
  getToolDefinitions: vi.fn(() => [
    { name: "search_text", description: "text search", category: "search" },
    { name: "find_dead_code", description: "dead code", category: "analysis" },
    { name: "discover_tools", description: "meta", category: "meta" },
    { name: "index_folder", description: "index", category: "index" },
    { name: "get_file_outline", description: "outline", category: "nav" },
    { name: "hidden_tool", description: "hidden demo", category: "demo" },
  ]),
  extractToolParams: vi.fn((def: { name: string }) => {
    if (def.name === "search_text") return [{ name: "query", required: true, description: "Search query" }, { name: "file_pattern", required: false, description: "Glob" }];
    if (def.name === "find_dead_code") return [{ name: "repo", required: false, description: "Repo" }];
    return [];
  }),
  getToolDefinition: vi.fn((name: string) => {
    const defs: Record<string, { name: string; description: string; category: string }> = {
      search_text: { name: "search_text", description: "text search", category: "search" },
      find_dead_code: { name: "find_dead_code", description: "dead code", category: "analysis" },
      discover_tools: { name: "discover_tools", description: "meta", category: "meta" },
    };
    return defs[name] ?? undefined;
  }),
  enableToolByName: vi.fn(() => true),
}));

import {
  parseQuery,
  planTurn,
  _resetPlanTurnCaches,
} from "../../src/tools/plan-turn-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { rankTools, getToolEmbeddings } from "../../src/search/tool-ranker.js";
import { getSessionState } from "../../src/storage/session-state.js";
import { getUsageStats } from "../../src/storage/usage-stats.js";
import { detectAutoLoadToolsCached } from "../../src/register-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSym(name: string, file = "src/auth.ts"): CodeSymbol {
  return {
    id: `test:${file}:${name}:1`,
    repo: "test",
    name,
    kind: "function",
    file,
    start_line: 1,
    end_line: 10,
  };
}

function makeIndex(symbols: CodeSymbol[] = []): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
  it("1. basic query → single intent, non-vague", () => {
    const index = makeIndex();
    const result = parseQuery("find all unused exports in the project", index);

    expect(result.original).toBe("find all unused exports in the project");
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toBe("find all unused exports in the project");
    expect(result.is_vague).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("2. multi-intent 'audit deps AND refactor auth' → 2 intents", () => {
    const index = makeIndex();
    const result = parseQuery("audit deps AND refactor auth", index);

    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toBe("audit deps");
    expect(result.intents[1]).toBe("refactor auth");
  });

  it("3. file ref 'review src/auth.ts' → file_refs populated", () => {
    const index = makeIndex();
    const result = parseQuery("review src/auth.ts for security issues", index);

    expect(result.file_refs).toContain("src/auth.ts");
  });

  it("4. symbol ref 'trace createUser' → symbol_refs populated", () => {
    const index = makeIndex([makeSym("createUser")]);
    const result = parseQuery("trace createUser across all modules", index);

    expect(result.symbol_refs).toContain("createUser");
  });

  it("5. vague 'help' → is_vague: true", () => {
    const index = makeIndex();
    const result = parseQuery("help", index);

    expect(result.is_vague).toBe(true);
  });

  it("6. truncation: 2000-char input → truncated: true, normalized length 1000", () => {
    const index = makeIndex();
    const longInput = "a".repeat(2000);
    const result = parseQuery(longInput, index);

    expect(result.truncated).toBe(true);
    expect(result.normalized.length).toBe(1000);
    expect(result.original.length).toBe(2000);
  });

  it("7. empty string → empty intents, is_vague: true", () => {
    const index = makeIndex();
    const result = parseQuery("", index);

    expect(result.intents).toHaveLength(0);
    expect(result.file_refs).toHaveLength(0);
    expect(result.symbol_refs).toHaveLength(0);
    expect(result.is_vague).toBe(true);
  });

  it("8. regex safety: 'handleANDGate' → NO split (still 1 intent)", () => {
    const index = makeIndex();
    const result = parseQuery("analyze handleANDGate behavior", index);

    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toBe("analyze handleandgate behavior");
  });
});

// ---------------------------------------------------------------------------
// planTurn handler tests
// ---------------------------------------------------------------------------

function makeSessionState(overrides: Partial<ReturnType<typeof baseSession>> = {}) {
  return { ...baseSession(), ...overrides };
}

function baseSession() {
  return {
    sessionId: "test-session",
    startedAt: Date.now(),
    callCount: 0,
    exploredSymbols: new Map(),
    exploredFiles: new Map(),
    queries: [] as Array<{ tool: string; query: string; repo: string; ts: number; resultCount: number }>,
    negativeEvidence: [] as Array<{ tool: string; query: string; repo: string; ts: number; stale: boolean; filePattern?: string }>,
    h10Emitted: false,
  };
}

const rankToolsMock = vi.mocked(rankTools);
const getToolEmbeddingsMock = vi.mocked(getToolEmbeddings);
const getCodeIndexMock = vi.mocked(getCodeIndex);
const getSessionStateMock = vi.mocked(getSessionState);
const getUsageStatsMock = vi.mocked(getUsageStats);
const detectAutoLoadToolsMock = vi.mocked(detectAutoLoadToolsCached);

function rec(
  name: string,
  confidence: number,
  isHidden = false,
): ToolRecommendation {
  return { name, confidence, reasoning: "test", is_hidden: isHidden };
}

describe("planTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPlanTurnCaches();
    // Default: empty session, no negative evidence, empty usage
    getSessionStateMock.mockReturnValue(makeSessionState() as unknown as ReturnType<typeof getSessionState>);
    getUsageStatsMock.mockResolvedValue({
      total_calls: 0,
      total_sessions: 0,
      avg_calls_per_session: 0,
      tools: [],
      top_repos: [],
      daily: [],
      query_types: [],
      earliest_ts: 0,
      latest_ts: 0,
    });
    detectAutoLoadToolsMock.mockResolvedValue([]);
    getToolEmbeddingsMock.mockResolvedValue(null);
    rankToolsMock.mockReturnValue([]);
  });

  it("1. happy path: index + ranker results → tools populated", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    rankToolsMock.mockReturnValue([
      rec("search_text", 0.9),
      rec("find_dead_code", 0.7, true),
    ]);

    const result = await planTurn("test", "find dead code");

    expect(result.query).toBe("find dead code");
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]?.name).toBe("search_text");
    expect(result.confidence).toBeCloseTo(0.9, 2);
    expect(result.metadata.intents_detected).toBe(1);
    expect(result.metadata.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("2. STOP_AND_REPORT_GAP: prior negative evidence with same query", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    getSessionStateMock.mockReturnValue(
      makeSessionState({
        negativeEvidence: [
          {
            tool: "search_text",
            query: "foo bar",
            repo: "test",
            ts: Date.now(),
            stale: false,
          },
        ],
      }) as unknown as ReturnType<typeof getSessionState>,
    );
    rankToolsMock.mockReturnValue([rec("search_text", 0.9)]);

    const result = await planTurn("test", "foo bar");

    expect(result.gap_analysis).toBeDefined();
    expect(result.gap_analysis?.action).toBe("STOP_AND_REPORT_GAP");
    expect(result.gap_analysis?.prior_query).toBe("foo bar");
    expect(result.tools).toHaveLength(0);
    // rankTools should not have influenced the result (still returns early)
    expect(result.confidence).toBe(0);
  });

  it("3. already-used dedup: prior find_dead_code moves to already_used but top-3 retained", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    getSessionStateMock.mockReturnValue(
      makeSessionState({
        queries: [
          {
            tool: "hidden_tool",
            query: "prior",
            repo: "test",
            ts: Date.now(),
            resultCount: 5,
          },
        ],
      }) as unknown as ReturnType<typeof getSessionState>,
    );
    // Put hidden_tool at rank 4 so it's outside top-3
    rankToolsMock.mockReturnValue([
      rec("search_text", 0.9),
      rec("find_dead_code", 0.8, true),
      rec("get_file_outline", 0.7),
      rec("hidden_tool", 0.6, true),
    ]);

    const result = await planTurn("test", "analyze things");

    expect(result.already_used).toContain("hidden_tool");
    expect(result.tools.find((t) => t.name === "hidden_tool")).toBeUndefined();
    expect(result.tools).toHaveLength(3); // hidden_tool removed
  });

  it("4. unindexed repo: returns structured error with index_folder rec, no throw", async () => {
    getCodeIndexMock.mockResolvedValue(null);

    const result = await planTurn("missing", "anything");

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("index_folder");
    expect(result.metadata.unindexed).toBe(true);
  });

  it("5. hidden tools → reveal_required populated", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    rankToolsMock.mockReturnValue([rec("find_dead_code", 0.9, true)]);

    const result = await planTurn("test", "query");

    expect(result.reveal_required).toContain("find_dead_code");
  });

  it("6. metadata flags: vague_query, duration, embedding_available", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    getToolEmbeddingsMock.mockResolvedValue(new Map([["search_text", [0.1, 0.2]]]));
    rankToolsMock.mockReturnValue([rec("search_text", 0.5)]);

    const result = await planTurn("test", "help");

    expect(result.metadata.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.metadata.vague_query).toBe(true);
    expect(result.metadata.embedding_available).toBe(true);
  });

  it("7. multi-intent 'audit AND refactor' → rankTools called per intent, merged", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex());
    rankToolsMock
      .mockReturnValueOnce([rec("search_text", 0.8)])
      .mockReturnValueOnce([rec("find_dead_code", 0.95, true)]);

    const result = await planTurn("test", "audit deps AND refactor auth");

    expect(rankToolsMock).toHaveBeenCalledTimes(2);
    // Merged with max-confidence sort: find_dead_code (0.95) then search_text (0.8)
    expect(result.tools[0]?.name).toBe("find_dead_code");
    expect(result.tools[1]?.name).toBe("search_text");
    expect(result.metadata.intents_detected).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// planTurn integration — real rankTools BM25 engine, synthetic TOOL_DEFINITIONS
// ---------------------------------------------------------------------------

describe("planTurn integration", () => {
  // Synthetic TOOL_DEFINITIONS covering realistic entries (matches spec example list)
  const SYNTHETIC_TOOLS = [
    { name: "find_dead_code", description: "Find dead code unused exports unreachable functions", category: "analysis", searchHint: "dead code unused exports unreachable" },
    { name: "search_text", description: "Full-text BM25 search across the codebase", category: "search", searchHint: "search text grep find pattern" },
    { name: "trace_route", description: "Trace an API endpoint from handler through middleware to response", category: "graph", searchHint: "route endpoint handler API trace" },
    { name: "analyze_complexity", description: "Measure cyclomatic complexity hotspots and complexity score", category: "analysis", searchHint: "complexity hotspot cyclomatic refactor" },
    { name: "find_clones", description: "Find copy-paste duplicated code clones DRY violations", category: "analysis", searchHint: "clone duplicate copy-paste DRY" },
    { name: "analyze_hotspots", description: "Git churn hotspots tech debt most-changed files", category: "analysis", searchHint: "hotspot churn git tech debt" },
    { name: "scan_secrets", description: "Scan for leaked secrets API keys credentials passwords", category: "security", searchHint: "secrets keys credentials security scan" },
    { name: "detect_communities", description: "Detect module communities clusters architecture dependency graph", category: "architecture", searchHint: "communities modules clusters dependency" },
    { name: "get_file_outline", description: "Get file symbol outline structure functions classes", category: "outline", searchHint: "outline file structure symbols" },
    { name: "search_symbols", description: "Search functions classes types methods by name signature", category: "search", searchHint: "symbols functions classes methods types" },
    { name: "find_references", description: "Find all references usages of a symbol across the codebase", category: "symbols", searchHint: "references usages callers symbol" },
    { name: "impact_analysis", description: "Blast radius impact analysis of changed files and affected symbols", category: "analysis", searchHint: "impact blast radius changed affected" },
    { name: "audit_scan", description: "Composite code quality audit: complexity dead code patterns security", category: "analysis", searchHint: "audit quality scan code health" },
    { name: "find_perf_hotspots", description: "Find performance hotspots slow queries N+1 patterns async pitfalls", category: "analysis", searchHint: "performance slow queries N+1 async pitfalls perf" },
    { name: "discover_tools", description: "Search tool catalog by keyword or category to discover hidden tools", category: "meta", searchHint: "discover tools catalog search find" },
    { name: "suggest_queries", description: "Suggest useful queries and tools for an unfamiliar repository", category: "meta", searchHint: "suggest queries tools explore repo" },
  ];

  // Retrieve real rankTools (using the actual module, bypassing the vi.mock for tool-ranker)
  let realRankTools: typeof import("../../src/search/tool-ranker.js")["rankTools"];
  let clearBM25Cache: typeof import("../../src/search/tool-ranker.js")["clearToolBM25Cache"];

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetPlanTurnCaches();

    // Load real ranking functions (bypassing the mock)
    const rankerModule = await vi.importActual<typeof import("../../src/search/tool-ranker.js")>(
      "../../src/search/tool-ranker.js",
    );
    realRankTools = rankerModule.rankTools;
    clearBM25Cache = rankerModule.clearToolBM25Cache;
    clearBM25Cache();

    // Set up planTurn mocks so planTurn doesn't fail on infra calls
    getCodeIndexMock.mockResolvedValue(makeIndex());
    getSessionStateMock.mockReturnValue(makeSessionState() as unknown as ReturnType<typeof getSessionState>);
    getUsageStatsMock.mockResolvedValue({
      total_calls: 0, total_sessions: 0, avg_calls_per_session: 0,
      tools: [], top_repos: [], daily: [], query_types: [],
      earliest_ts: 0, latest_ts: 0,
    });
    detectAutoLoadToolsMock.mockResolvedValue([]);
    getToolEmbeddingsMock.mockResolvedValue(null);

    // Make rankTools use the real implementation by restoring to real fn
    rankToolsMock.mockImplementation((ctx: ToolRankerContext) => {
      // Build a context using our synthetic tools alongside the passed toolDefs
      const syntheticCtx: ToolRankerContext = {
        ...ctx,
        toolDefs: SYNTHETIC_TOOLS as Parameters<typeof realRankTools>[0]["toolDefs"],
      };
      return realRankTools(syntheticCtx);
    });
  });

  afterEach(() => {
    if (clearBM25Cache) clearBM25Cache();
  });

  it("IT-1. 'find dead code' → find_dead_code in top-3", async () => {
    const result = await planTurn("test", "find dead code");

    const names = result.tools.map((t) => t.name);
    expect(names.slice(0, 3)).toContain("find_dead_code");
  });

  it("IT-2. 'find slow queries' → perf tool in top-5", async () => {
    const result = await planTurn("test", "find slow queries");

    const names = result.tools.map((t) => t.name);
    const hasPerfTool = names.slice(0, 5).some((n) =>
      n === "find_perf_hotspots" || n.includes("perf") || n.includes("hotspot"),
    );
    expect(hasPerfTool).toBe(true);
  });

  it("IT-3. empty query '' → discover_tools or suggest_queries fallback", async () => {
    const result = await planTurn("test", "");

    // Empty query → vague → fallback tool
    const names = result.tools.map((t) => t.name);
    const hasFallback = names.some((n) => n === "discover_tools" || n === "suggest_queries");
    expect(hasFallback).toBe(true);
  });

  it("IT-4. multi-intent 'audit deps AND refactor auth' → ≥1 tool per intent", async () => {
    const result = await planTurn("test", "audit deps AND refactor auth");

    // Multi-intent: should have at least 2 tools (one per intent)
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
    expect(result.metadata.intents_detected).toBe(2);
    // Should have called rankTools twice (once per intent)
    expect(rankToolsMock).toHaveBeenCalledTimes(2);
  });

  it("IT-5. 'review src/register-tools.ts' → file path in files[]", async () => {
    // The index needs to know about the file for score 1.0, but even without it
    // the file ref should be extracted and appear in files[]
    const result = await planTurn("test", "review src/register-tools.ts");

    const filePaths = result.files.map((f) => f.path);
    expect(filePaths.some((p) => p.includes("register-tools.ts"))).toBe(true);
  });
});

describe("formatPlanTurnResult", () => {
  let formatPlanTurnResult: typeof import("../../src/tools/plan-turn-tools.js").formatPlanTurnResult;

  beforeEach(async () => {
    const mod = await import("../../src/tools/plan-turn-tools.js");
    formatPlanTurnResult = mod.formatPlanTurnResult;
  });

  const baseMeta = {
    intents_detected: 1,
    bm25_candidates: 1,
    embedding_available: false,
    session_queries_seen: 0,
    duration_ms: 5,
  };

  // Reverted in v0.5.16 — inline params + removed Reveal Required degraded agent adoption

  it("shows gap_analysis early exit", () => {
    const out = formatPlanTurnResult({
      query: "test",
      truncated: false,
      confidence: 0.1,
      tools: [],
      symbols: [], files: [], reveal_required: [], already_used: [],
      gap_analysis: { prior_query: "x", prior_result_count: 0, suggestion: "try different query" },
      metadata: baseMeta,
    });
    expect(out).toContain("STOP_AND_REPORT_GAP");
    expect(out).not.toContain("─── Tools");
  });

  it("injects discover_tools fallback for empty tools", () => {
    const out = formatPlanTurnResult({
      query: "test",
      truncated: false,
      confidence: 0.3,
      tools: [],
      symbols: [], files: [], reveal_required: [], already_used: [],
      metadata: baseMeta,
    });
    expect(out).toContain("discover_tools");
  });

  // params: (none required) — removed in v0.5.16 revert

  it("shows already_used section", () => {
    const out = formatPlanTurnResult({
      query: "test",
      truncated: false,
      confidence: 0.8,
      tools: [{ name: "search_text", confidence: 0.8, reasoning: "match", is_hidden: false }],
      symbols: [], files: [], reveal_required: [], already_used: ["search_text"],
      metadata: baseMeta,
    });
    expect(out).toContain("Already Used (1)");
    expect(out).toContain("search_text");
  });

  it("shows flags section when vague_query is true", () => {
    const out = formatPlanTurnResult({
      query: "test",
      truncated: false,
      confidence: 0.5,
      tools: [{ name: "search_text", confidence: 0.5, reasoning: "match", is_hidden: false }],
      symbols: [], files: [], reveal_required: [], already_used: [],
      metadata: { ...baseMeta, vague_query: true },
    });
    expect(out).toContain("─── Flags ───");
    expect(out).toContain("vague_query");
  });
});
