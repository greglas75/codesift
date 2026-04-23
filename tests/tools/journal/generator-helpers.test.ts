import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mock for child_process.execFileSync (used by filterPhasesBySince for git-relative strings)
const h = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync: h.execFileSync }));

import {
  filterPhasesBySince,
  filterPhasesByScope,
  shouldSkipPhaseByHash,
} from "../../../src/tools/journal-generator-helpers.js";
import type { PhasePlan } from "../../../src/tools/journal-phase-detector.js";

const mkPhase = (slug: string, startDate: string, endDate: string, commitDate?: string): PhasePlan => ({
  slug, title: slug, startDate, endDate,
  commits: [{ sha: "a".repeat(40), date: `${commitDate ?? endDate}T00:00:00Z`, authorName: "Dev",
    subject: `feat(${slug}): x`, parentShas: [], refs: [] }],
  source: "auto",
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("filterPhasesBySince (ISO date)", () => {
  it("keeps phases whose endDate >= cutoff", () => {
    const phases = [
      mkPhase("old", "2026-04-01", "2026-04-10"),
      mkPhase("boundary", "2026-04-12", "2026-04-15"),
      mkPhase("fresh", "2026-04-18", "2026-04-22"),
    ];
    const result = filterPhasesBySince(phases, "2026-04-15");
    expect(result.map((p) => p.slug)).toEqual(["boundary", "fresh"]);
  });

  it("returns all phases when since is unparseable and git fails", () => {
    h.execFileSync.mockImplementation(() => { throw new Error("git not found"); });
    const phases = [mkPhase("p1", "2026-04-01", "2026-04-10")];
    const result = filterPhasesBySince(phases, "gibberish");
    expect(result).toHaveLength(1);
  });
});

describe("filterPhasesBySince (git-relative)", () => {
  it("resolves git-relative string via execFileSync", () => {
    h.execFileSync.mockReturnValue("2026-04-15T00:00:00Z\n");
    const phases = [
      mkPhase("old", "2026-04-01", "2026-04-10"),
      mkPhase("fresh", "2026-04-18", "2026-04-22"),
    ];
    const result = filterPhasesBySince(phases, "2 weeks ago", "/repo");
    expect(h.execFileSync).toHaveBeenCalledWith("git",
      ["log", "-1", "--format=%aI", "--since", "2 weeks ago"], expect.any(Object));
    expect(result.map((p) => p.slug)).toEqual(["fresh"]);
  });
});

describe("filterPhasesByScope", () => {
  it("filters by phase slug", () => {
    const phases = [mkPhase("a", "2026-04-01", "2026-04-05"), mkPhase("b", "2026-04-06", "2026-04-10")];
    expect(filterPhasesByScope(phases, { phase: "b" }).map((p) => p.slug)).toEqual(["b"]);
  });

  it("filters by entry date matching commit", () => {
    const phases = [
      mkPhase("a", "2026-04-01", "2026-04-05", "2026-04-03"),
      mkPhase("b", "2026-04-06", "2026-04-10", "2026-04-08"),
    ];
    expect(filterPhasesByScope(phases, { entry: "2026-04-08" }).map((p) => p.slug)).toEqual(["b"]);
  });

  it("filters by entry date within phase date range", () => {
    const phases = [mkPhase("a", "2026-04-01", "2026-04-05", "2026-04-01")];
    // Entry date not in commit list, but inside range
    expect(filterPhasesByScope(phases, { entry: "2026-04-03" }).map((p) => p.slug)).toEqual(["a"]);
  });

  it("throws when neither entry nor phase provided", () => {
    expect(() => filterPhasesByScope([], {})).toThrow(/entry or phase/i);
  });
});

describe("shouldSkipPhaseByHash (Phase A signature stub)", () => {
  it("always returns false pending Phase C manifest wiring", () => {
    expect(shouldSkipPhaseByHash("slug", "hash")).toBe(false);
    expect(shouldSkipPhaseByHash("slug", "hash", { force: true })).toBe(false);
  });
});
