import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import type { ToolRecommendation } from "../../src/search/tool-ranker.js";

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
  getToolDefinitions: vi.fn(() => [
    { name: "search_text", description: "text search", category: "search" },
    { name: "find_dead_code", description: "dead code", category: "analysis" },
    { name: "discover_tools", description: "meta", category: "meta" },
    { name: "index_folder", description: "index", category: "index" },
    { name: "get_file_outline", description: "outline", category: "nav" },
    { name: "hidden_tool", description: "hidden demo", category: "demo" },
  ]),
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
import { detectAutoLoadTools } from "../../src/register-tools.js";

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
const detectAutoLoadToolsMock = vi.mocked(detectAutoLoadTools);

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
