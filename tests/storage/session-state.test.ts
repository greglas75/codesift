import { describe, it, expect, beforeEach } from "vitest";
import {
  resetSession,
  getSessionState,
  getCallCount,
  recordToolCall,
  recordCacheHit,
} from "../../src/storage/session-state.js";
import { getSessionId } from "../../src/storage/usage-tracker.js";

describe("session-state", () => {
  beforeEach(() => {
    resetSession();
  });

  describe("initial state", () => {
    it("has sessionId matching usage-tracker SESSION_ID", () => {
      const state = getSessionState();
      expect(state.sessionId).toBe(getSessionId());
    });

    it("has startedAt as a recent timestamp", () => {
      const state = getSessionState();
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.startedAt).toBeLessThanOrEqual(Date.now());
    });

    it("has callCount of 0", () => {
      expect(getCallCount()).toBe(0);
    });

    it("has empty exploredSymbols map", () => {
      const state = getSessionState();
      expect(state.exploredSymbols).toBeInstanceOf(Map);
      expect(state.exploredSymbols.size).toBe(0);
    });

    it("has empty exploredFiles map", () => {
      const state = getSessionState();
      expect(state.exploredFiles).toBeInstanceOf(Map);
      expect(state.exploredFiles.size).toBe(0);
    });

    it("has empty queries array", () => {
      const state = getSessionState();
      expect(state.queries).toEqual([]);
    });

    it("has empty negativeEvidence array", () => {
      const state = getSessionState();
      expect(state.negativeEvidence).toEqual([]);
    });
  });

  describe("resetSession", () => {
    it("clears all state back to initial values", () => {
      // Mutate state to verify reset clears it
      const state = getSessionState();
      state.callCount = 42;
      state.exploredSymbols.set("test-sym", {
        symbolId: "test-sym",
        name: "testFn",
        file: "test.ts",
        firstSeen: 1000,
        lastSeen: 2000,
        accessCount: 3,
      });
      state.exploredFiles.set("/some/path.ts", {
        path: "/some/path.ts",
        firstSeen: 1000,
        lastSeen: 2000,
        accessCount: 1,
      });
      state.queries.push({
        tool: "search_text",
        query: "foo",
        repo: "local/test",
        ts: 1000,
        resultCount: 5,
      });
      state.negativeEvidence.push({
        tool: "search_symbols",
        query: "missing",
        repo: "local/test",
        ts: 1000,
        stale: false,
      });

      resetSession();

      expect(getCallCount()).toBe(0);
      const fresh = getSessionState();
      expect(fresh.exploredSymbols.size).toBe(0);
      expect(fresh.exploredFiles.size).toBe(0);
      expect(fresh.queries).toEqual([]);
      expect(fresh.negativeEvidence).toEqual([]);
      // sessionId should still match usage-tracker (same process)
      expect(fresh.sessionId).toBe(getSessionId());
    });

    it("resets h10Emitted flag", () => {
      const state = getSessionState();
      state.h10Emitted = true;
      resetSession();
      expect(getSessionState().h10Emitted).toBe(false);
    });
  });

  describe("recordToolCall", () => {
    it("increments callCount", () => {
      recordToolCall("search_text", { query: "foo", repo: "local/test" }, 3, { matches: [{}, {}, {}] });
      expect(getCallCount()).toBe(1);
      recordToolCall("search_text", { query: "bar", repo: "local/test" }, 1, { matches: [{}] });
      expect(getCallCount()).toBe(2);
    });

    it("extracts symbols from result data", () => {
      recordToolCall("search_symbols", { query: "fn", repo: "local/test" }, 2, {
        symbols: [
          { id: "sym1", name: "fn1", file: "a.ts" },
          { id: "sym2", name: "fn2", file: "b.ts" },
        ],
      });
      const state = getSessionState();
      expect(state.exploredSymbols.size).toBe(2);
      expect(state.exploredSymbols.get("sym1")?.name).toBe("fn1");
      expect(state.exploredSymbols.get("sym2")?.file).toBe("b.ts");
    });

    it("deduplicates symbols and increments accessCount", () => {
      recordToolCall("search_symbols", { query: "fn", repo: "local/test" }, 1, {
        symbols: [{ id: "sym1", name: "fn1", file: "a.ts" }],
      });
      recordToolCall("get_symbol", { symbol_id: "sym1", repo: "local/test" }, 1, {
        id: "sym1", name: "fn1", file: "a.ts",
      });
      const entry = getSessionState().exploredSymbols.get("sym1");
      expect(entry?.accessCount).toBe(2);
      expect(entry?.lastSeen).toBeGreaterThanOrEqual(entry?.firstSeen ?? 0);
    });

    it("extracts file paths from result data", () => {
      recordToolCall("get_file_outline", { file_path: "/src/server.ts", repo: "local/test" }, 1, {
        file: "/src/server.ts", symbols: [],
      });
      const state = getSessionState();
      expect(state.exploredFiles.has("/src/server.ts")).toBe(true);
    });

    it("extracts file_path from args for single-file tools", () => {
      recordToolCall("index_file", { path: "/src/new-file.ts", repo: "local/test" }, 1, {});
      const state = getSessionState();
      expect(state.exploredFiles.has("/src/new-file.ts")).toBe(true);
    });

    it("appends to queries when args.query is present", () => {
      recordToolCall("search_text", { query: "wrapTool", repo: "local/test" }, 5, {
        matches: [{}, {}, {}, {}, {}],
      });
      const state = getSessionState();
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0]).toMatchObject({
        tool: "search_text",
        query: "wrapTool",
        repo: "local/test",
        resultCount: 5,
      });
    });

    it("does not append to queries when args.query is absent", () => {
      recordToolCall("get_file_tree", { path_prefix: "src/", repo: "local/test" }, 10, {
        files: [],
      });
      expect(getSessionState().queries).toHaveLength(0);
    });

    it("handles null/undefined resultData gracefully", () => {
      expect(() => {
        recordToolCall("list_repos", {}, 0, null);
      }).not.toThrow();
      expect(getCallCount()).toBe(1);
    });
  });

  describe("recordCacheHit", () => {
    it("increments callCount", () => {
      recordCacheHit("search_text", { query: "foo", repo: "local/test" });
      expect(getCallCount()).toBe(1);
    });

    it("does NOT append to negativeEvidence even for search tools", () => {
      recordCacheHit("search_text", { query: "missing", repo: "local/test" });
      expect(getSessionState().negativeEvidence).toHaveLength(0);
    });
  });
});
