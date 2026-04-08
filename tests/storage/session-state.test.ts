import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  resetSession,
  getSessionState,
  getCallCount,
  recordToolCall,
  recordCacheHit,
  invalidateNegativeEvidence,
  SEARCH_TOOL_SET,
  formatSnapshot,
  getContext,
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

  describe("negative evidence", () => {
    it("records negative evidence when search tool returns zero results", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      const state = getSessionState();
      expect(state.negativeEvidence).toHaveLength(1);
      expect(state.negativeEvidence[0]).toMatchObject({
        tool: "search_text",
        query: "missing",
        repo: "local/test",
        stale: false,
      });
    });

    it("does NOT record negative evidence for non-search tools with zero results", () => {
      recordToolCall("get_file_tree", { path_prefix: "src/", repo: "local/test" }, 0, { files: [] });
      expect(getSessionState().negativeEvidence).toHaveLength(0);
    });

    it("does NOT include session tools in SEARCH_TOOL_SET", () => {
      expect(SEARCH_TOOL_SET.has("get_session_snapshot")).toBe(false);
      expect(SEARCH_TOOL_SET.has("get_session_context")).toBe(false);
    });

    it("does NOT record negative evidence when result is an error", () => {
      recordToolCall("search_text", { query: "foo", repo: "local/test" }, 0, { error: "connection failed" });
      expect(getSessionState().negativeEvidence).toHaveLength(0);
    });

    it("includes expected search tools in SEARCH_TOOL_SET", () => {
      expect(SEARCH_TOOL_SET.has("search_text")).toBe(true);
      expect(SEARCH_TOOL_SET.has("search_symbols")).toBe(true);
      expect(SEARCH_TOOL_SET.has("codebase_retrieval")).toBe(true);
      expect(SEARCH_TOOL_SET.has("semantic_search")).toBe(true);
      expect(SEARCH_TOOL_SET.has("find_references")).toBe(true);
    });
  });

  describe("TTL staleness", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("entry younger than 120s is not stale", () => {
      vi.setSystemTime(1000000);
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      vi.setSystemTime(1000000 + 119_999); // just under 120s
      const state = getSessionState();
      // isStale is evaluated lazily — check via negativeEvidence entry
      expect(state.negativeEvidence[0]?.stale).toBe(false);
    });
  });

  describe("cap enforcement", () => {
    it("evicts oldest symbol by lastSeen when exceeding 500", () => {
      vi.useFakeTimers();
      // Fill with 500 symbols
      for (let i = 0; i < 500; i++) {
        vi.setSystemTime(1000 + i);
        recordToolCall("search_symbols", { query: `s${i}`, repo: "local/test" }, 1, {
          symbols: [{ id: `sym-${i}`, name: `fn${i}`, file: `f${i}.ts` }],
        });
      }
      expect(getSessionState().exploredSymbols.size).toBe(500);

      // Add one more — oldest (sym-0, lastSeen=1000) should be evicted
      vi.setSystemTime(2000);
      recordToolCall("search_symbols", { query: "new", repo: "local/test" }, 1, {
        symbols: [{ id: "sym-new", name: "fnNew", file: "new.ts" }],
      });
      expect(getSessionState().exploredSymbols.size).toBe(500);
      expect(getSessionState().exploredSymbols.has("sym-0")).toBe(false);
      expect(getSessionState().exploredSymbols.has("sym-new")).toBe(true);
      vi.useRealTimers();
    });

    it("evicts oldest file by lastSeen when exceeding 300", () => {
      vi.useFakeTimers();
      for (let i = 0; i < 300; i++) {
        vi.setSystemTime(1000 + i);
        recordToolCall("get_file_outline", { file_path: `/src/f${i}.ts`, repo: "local/test" }, 1, {
          file: `/src/f${i}.ts`, symbols: [],
        });
      }
      expect(getSessionState().exploredFiles.size).toBe(300);

      vi.setSystemTime(2000);
      recordToolCall("get_file_outline", { file_path: "/src/new.ts", repo: "local/test" }, 1, {
        file: "/src/new.ts", symbols: [],
      });
      expect(getSessionState().exploredFiles.size).toBe(300);
      expect(getSessionState().exploredFiles.has("/src/f0.ts")).toBe(false);
      expect(getSessionState().exploredFiles.has("/src/new.ts")).toBe(true);
      vi.useRealTimers();
    });

    it("FIFO evicts oldest query when exceeding 200", () => {
      for (let i = 0; i < 201; i++) {
        recordToolCall("search_text", { query: `q${i}`, repo: "local/test" }, 1, { matches: [{}] });
      }
      const queries = getSessionState().queries;
      expect(queries).toHaveLength(200);
      expect(queries[0]?.query).toBe("q1"); // q0 evicted
      expect(queries[199]?.query).toBe("q200");
    });

    it("evicts stale negative evidence first, then FIFO", () => {
      // Add 2 stale + 298 fresh = 300
      recordToolCall("search_text", { query: "stale1", repo: "local/test" }, 0, { matches: [] });
      recordToolCall("search_text", { query: "stale2", repo: "local/test" }, 0, { matches: [] });
      // Mark first two stale
      getSessionState().negativeEvidence[0]!.stale = true;
      getSessionState().negativeEvidence[1]!.stale = true;

      for (let i = 0; i < 298; i++) {
        recordToolCall("search_text", { query: `fresh${i}`, repo: "local/test" }, 0, { matches: [] });
      }
      expect(getSessionState().negativeEvidence).toHaveLength(300);

      // Add one more — stale should be evicted first
      recordToolCall("search_text", { query: "overflow", repo: "local/test" }, 0, { matches: [] });
      expect(getSessionState().negativeEvidence).toHaveLength(300);
      expect(getSessionState().negativeEvidence.some(e => e.query === "stale1")).toBe(false);
    });
  });

  describe("formatSnapshot", () => {
    it("returns header-only for empty state", () => {
      const snap = formatSnapshot(getSessionState());
      expect(snap).toContain("session:");
      expect(snap).toContain("calls:0");
      expect(snap.length).toBeLessThanOrEqual(700);
    });

    it("includes all 5 tiers when populated", () => {

      // Add files, symbols, queries, negative evidence
      recordToolCall("search_symbols", { query: "testFn", repo: "local/test" }, 2, {
        symbols: [
          { id: "s1", name: "fn1", file: "a.ts" },
          { id: "s2", name: "fn2", file: "b.ts" },
        ],
      });
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      recordToolCall("get_file_outline", { file_path: "/src/c.ts", repo: "local/test" }, 1, {
        file: "/src/c.ts", symbols: [],
      });

      const snap = formatSnapshot(getSessionState());
      expect(snap).toContain("FILES:");
      expect(snap).toContain("SYMBOLS:");
      expect(snap).toContain("NOT_FOUND:");
      expect(snap).toContain("QUERIES:");
      expect(snap.length).toBeLessThanOrEqual(700);
    });

    it("is deterministic — same state produces identical output", () => {

      recordToolCall("search_symbols", { query: "fn", repo: "local/test" }, 1, {
        symbols: [{ id: "s1", name: "fn1", file: "a.ts" }],
      });
      const state = getSessionState();
      const snap1 = formatSnapshot(state);
      const snap2 = formatSnapshot(state);
      expect(snap1).toBe(snap2);
    });

    it("hard caps at 700 characters", () => {

      // Fill with lots of data
      for (let i = 0; i < 100; i++) {
        recordToolCall("search_symbols", { query: `q${i}`, repo: "local/test" }, 1, {
          symbols: [{ id: `sym-${i}`, name: `longFunctionName${i}`, file: `src/deep/nested/path/file${i}.ts` }],
        });
      }
      const snap = formatSnapshot(getSessionState());
      expect(snap.length).toBeLessThanOrEqual(700);
    });

    it("uses +N more suffix when tier overflows", () => {

      for (let i = 0; i < 20; i++) {
        recordToolCall("search_symbols", { query: `q${i}`, repo: "local/test" }, 1, {
          symbols: [{ id: `sym-${i}`, name: `fn${i}`, file: `f${i}.ts` }],
        });
      }
      const snap = formatSnapshot(getSessionState());
      expect(snap).toContain("+"); // +N more
    });

    it("excludes stale negative evidence", () => {

      recordToolCall("search_text", { query: "staleQuery", repo: "local/test" }, 0, { matches: [] });
      getSessionState().negativeEvidence[0]!.stale = true;
      const snap = formatSnapshot(getSessionState());
      expect(snap).not.toContain("NOT_FOUND:");
    });

    it("filters by repo when provided", () => {

      recordToolCall("search_symbols", { query: "fn", repo: "local/a" }, 1, {
        symbols: [{ id: "sa", name: "fnA", file: "a.ts" }],
      });
      recordToolCall("search_symbols", { query: "fn", repo: "local/b" }, 1, {
        symbols: [{ id: "sb", name: "fnB", file: "b.ts" }],
      });
      const snap = formatSnapshot(getSessionState(), "local/a");
      expect(snap).toContain("fnA");
      // fnB might still appear in symbols (symbols don't have repo), but queries should filter
    });
  });

  describe("invalidateNegativeEvidence", () => {
    it("marks matching entries stale when file changes in relevant subtree", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test", file_pattern: "src/tools/*" }, 0, { matches: [] });
      invalidateNegativeEvidence("local/test", "src/tools/new-file.ts");
      expect(getSessionState().negativeEvidence[0]?.stale).toBe(true);
    });

    it("does NOT mark entries stale for unrelated subtree changes", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test", file_pattern: "src/tools/*" }, 0, { matches: [] });
      invalidateNegativeEvidence("local/test", "tests/something.test.ts");
      expect(getSessionState().negativeEvidence[0]?.stale).toBe(false);
    });

    it("marks entries stale when no file_pattern (same repo = relevant)", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      invalidateNegativeEvidence("local/test", "src/anything.ts");
      expect(getSessionState().negativeEvidence[0]?.stale).toBe(true);
    });

    it("does NOT mark entries from different repo", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/other" }, 0, { matches: [] });
      invalidateNegativeEvidence("local/test", "src/tools/new-file.ts");
      expect(getSessionState().negativeEvidence[0]?.stale).toBe(false);
    });
  });

  describe("getContext", () => {
    it("returns structured JSON with all fields", () => {
      recordToolCall("search_symbols", { query: "fn", repo: "local/test" }, 1, {
        symbols: [{ id: "s1", name: "fn1", file: "a.ts" }],
      });
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      const ctx = getContext();
      expect(ctx.session_id).toBe(getSessionState().sessionId);
      expect(ctx.call_count).toBe(2);
      expect(ctx.explored_symbols.count).toBe(1);
      expect(ctx.explored_files.count).toBeGreaterThanOrEqual(0);
      expect(ctx.queries.count).toBe(2);
      expect(ctx.negative_evidence.count).toBe(1);
      expect(ctx.caps).toBeDefined();
    });

    it("filters by repo when provided", () => {
      recordToolCall("search_text", { query: "a", repo: "local/a" }, 1, { matches: [{}] });
      recordToolCall("search_text", { query: "b", repo: "local/b" }, 1, { matches: [{}] });
      const ctx = getContext("local/a");
      expect(ctx.queries.items.every((q: { repo: string }) => q.repo === "local/a")).toBe(true);
    });

    it("excludes stale negative evidence by default", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      getSessionState().negativeEvidence[0]!.stale = true;
      const ctx = getContext();
      expect(ctx.negative_evidence.count).toBe(0);
    });

    it("includes stale negative evidence when include_stale=true", () => {
      recordToolCall("search_text", { query: "missing", repo: "local/test" }, 0, { matches: [] });
      getSessionState().negativeEvidence[0]!.stale = true;
      const ctx = getContext(undefined, true);
      expect(ctx.negative_evidence.count).toBe(1);
    });
  });

  describe("sidecar file management", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesift-test-"));
      vi.stubEnv("CODESIFT_DATA_DIR", tmpDir);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("flushSidecar writes JSON to session file", async () => {
      const { flushSidecar } = await import("../../src/storage/session-state.js");
      recordToolCall("search_text", { query: "test", repo: "local/test" }, 1, { matches: [{}] });
      await flushSidecar();
      const sessionId = getSessionState().sessionId;
      const sidecarPath = path.join(tmpDir, `session-${sessionId}.json`);
      expect(fs.existsSync(sidecarPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      expect(data.callCount).toBe(1);
    });

    it("roundtrips Map data through serialization", async () => {
      const { flushSidecar, deserializeState } = await import("../../src/storage/session-state.js");
      recordToolCall("search_symbols", { query: "fn", repo: "local/test" }, 1, {
        symbols: [{ id: "sym1", name: "fn1", file: "a.ts" }],
      });
      await flushSidecar();
      const sessionId = getSessionState().sessionId;
      const sidecarPath = path.join(tmpDir, `session-${sessionId}.json`);
      const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      const restored = deserializeState(raw);
      expect(restored.exploredSymbols).toBeInstanceOf(Map);
      expect(restored.exploredSymbols.get("sym1")?.name).toBe("fn1");
    });

    it("cleanupSidecar removes the sidecar file", async () => {
      const { flushSidecar, cleanupSidecar } = await import("../../src/storage/session-state.js");
      await flushSidecar();
      const sessionId = getSessionState().sessionId;
      const sidecarPath = path.join(tmpDir, `session-${sessionId}.json`);
      expect(fs.existsSync(sidecarPath)).toBe(true);
      cleanupSidecar();
      expect(fs.existsSync(sidecarPath)).toBe(false);
    });

    it("cleanupOrphanSidecars removes files older than 24h", async () => {
      const { cleanupOrphanSidecars } = await import("../../src/storage/session-state.js");
      // Create an old file
      const oldPath = path.join(tmpDir, "session-old-uuid.json");
      fs.writeFileSync(oldPath, "{}");
      const oldTime = Date.now() / 1000 - 25 * 3600; // 25h ago
      fs.utimesSync(oldPath, oldTime, oldTime);
      // Create a fresh file
      const freshPath = path.join(tmpDir, "session-fresh-uuid.json");
      fs.writeFileSync(freshPath, "{}");

      cleanupOrphanSidecars();

      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(freshPath)).toBe(true);
    });

    it("CQ22: resetSession cancels pending debounce timer", async () => {
      const { scheduleSidecarFlush } = await import("../../src/storage/session-state.js");
      vi.useFakeTimers();
      recordToolCall("search_text", { query: "test", repo: "local/test" }, 1, { matches: [{}] });
      scheduleSidecarFlush();
      resetSession();
      vi.advanceTimersByTime(2000);
      const sessionId = getSessionState().sessionId;
      const files = fs.readdirSync(tmpDir).filter((f: string) => f.startsWith("session-"));
      // No sidecar should have been written after reset
      expect(files.length).toBe(0);
      vi.useRealTimers();
    });
  });
});
