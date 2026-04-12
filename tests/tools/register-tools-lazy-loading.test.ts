import { afterEach, describe, expect, it, vi } from "vitest";

function createMockServer() {
  const registeredTools = new Map<string, {
    name: string;
    enabled: boolean;
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    handler: unknown;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }>();
  return {
    registeredTools,
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      const handle = {
        name,
        enabled: true,
        disable: vi.fn(() => { handle.enabled = false; }),
        enable: vi.fn(() => { handle.enabled = true; }),
        handler,
        update: vi.fn(),
        remove: vi.fn(),
      };
      registeredTools.set(name, handle);
      return handle;
    }),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../../src/tools/search-tools.js");
  vi.doUnmock("../../src/tools/plan-turn-tools.js");
});

describe("registerTools lazy loading", () => {
  it("does not import search-tools until search_symbols is invoked", async () => {
    const searchSymbols = vi.fn(async () => []);
    const searchToolsFactory = vi.fn(() => ({
      searchSymbols,
      searchText: vi.fn(async () => []),
      semanticSearch: vi.fn(async () => []),
    }));
    vi.doMock("../../src/tools/search-tools.js", searchToolsFactory);

    const { registerTools } = await import("../../src/register-tools.js");
    const server = createMockServer();
    registerTools(server as any, { deferNonCore: true });

    expect(searchToolsFactory).not.toHaveBeenCalled();

    const handler = server.registeredTools.get("search_symbols")!.handler as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ repo: "local/test", query: "auth" });
    await handler({ repo: "local/test", query: "auth" });

    expect(searchToolsFactory).toHaveBeenCalledTimes(1);
    expect(searchSymbols).toHaveBeenCalledTimes(1);
  });

  it("auto-reveals hidden tools when plan_turn recommends them", async () => {
    const planTurn = vi.fn(async () => ({
      query: "find dead code",
      truncated: false,
      confidence: 0.99,
      tools: [
        {
          name: "find_dead_code",
          confidence: 0.99,
          reasoning: "best match",
          is_hidden: true,
        },
      ],
      symbols: [],
      files: [],
      reveal_required: ["find_dead_code"],
      already_used: [],
      metadata: {
        intents_detected: 1,
        bm25_candidates: 1,
        embedding_available: false,
        session_queries_seen: 0,
        duration_ms: 1,
      },
    }));
    const formatPlanTurnResult = vi.fn(() => "plan_turn: find dead code");
    vi.doMock("../../src/tools/plan-turn-tools.js", () => ({
      planTurn,
      formatPlanTurnResult,
    }));

    const { registerTools } = await import("../../src/register-tools.js");
    const server = createMockServer();
    registerTools(server as any, { deferNonCore: true });

    expect(server.registeredTools.get("find_dead_code")).toBeUndefined();

    const handler = server.registeredTools.get("plan_turn")!.handler as (args: Record<string, unknown>) => Promise<any>;
    const result = await handler({ repo: "local/test", query: "find dead code" });

    const hiddenHandle = server.registeredTools.get("find_dead_code")!;
    expect(planTurn).toHaveBeenCalledWith("local/test", "find dead code", {});
    expect(hiddenHandle).toBeDefined();
    expect(hiddenHandle.enable).toHaveBeenCalledTimes(1);
    expect(hiddenHandle.enabled).toBe(true);
    expect(result.content[0]?.text).toContain("plan_turn: find dead code");
  });
});
