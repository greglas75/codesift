import { describe, it, expect, beforeEach } from "vitest";
import {
  resetSession,
  getSessionState,
  getCallCount,
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
});
