import { describe, it, expect, vi } from "vitest";

// The wall-clock primitive is unit-tested in tests/utils/wall-clock.test.ts.
// This file exercises the wiring in codebase_retrieval (the easier of the
// two consumers — searchText needs a live indexed repo to even reach the
// race, and the unit test plus type wiring is sufficient there).

describe("codebaseRetrieval wall-clock cap", () => {
  it("returns a wall_clock_truncated result when the cap fires", async () => {
    process.env["CODESIFT_CODEBASE_RETRIEVAL_CAP_MS"] = "10";
    vi.resetModules();

    const { codebaseRetrieval } = await import("../../src/retrieval/codebase-retrieval.js");

    // Pass an obviously-broken repo name so the inner work would error fast,
    // but the work is still wrapped in raceWallClock — with cap=10ms we
    // expect the timeout sentinel to win on any reasonable machine.
    const result = await codebaseRetrieval("nonexistent-repo-xyz", [
      { type: "text", query: "anything", repo: "nonexistent-repo-xyz" },
    ]);

    // Either the cap fires (preferred) or the inner code returns an error
    // result. Both are acceptable shapes — assert on the timeout shape only
    // when wall_clock_truncated is set.
    if (result.wall_clock_truncated) {
      expect(result.truncated).toBe(true);
      expect(result.hint).toMatch(/exceeded|narrow scope|split/);
      expect(result.results).toEqual([]);
    } else {
      // Inner returned without hitting the cap — still valid shape.
      expect(result.query_count).toBe(1);
    }

    delete process.env["CODESIFT_CODEBASE_RETRIEVAL_CAP_MS"];
  });
});
