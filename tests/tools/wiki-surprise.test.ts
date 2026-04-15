import { describe, it, expect } from "vitest";
import {
  computeSurpriseScores,
  type CommunityInfo,
  type CrossEdge,
  type CoChangePair,
} from "../../src/tools/wiki-surprise.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const communityA: CommunityInfo = { name: "A", files: ["a1.ts", "a2.ts"], size: 2 };
const communityB: CommunityInfo = { name: "B", files: ["b1.ts", "b2.ts"], size: 2 };
const communityC: CommunityInfo = { name: "C", files: ["c1.ts"], size: 1 };

const crossEdgesAB: CrossEdge[] = [
  { from_community: "A", to_community: "B", from_file: "a1.ts", to_file: "b1.ts" },
  { from_community: "A", to_community: "B", from_file: "a2.ts", to_file: "b2.ts" },
];

const coChangePairsAB: CoChangePair[] = [
  { file_a: "a1.ts", file_b: "b1.ts", jaccard: 0.5 },
  { file_a: "a2.ts", file_b: "b2.ts", jaccard: 0.8 },
];

describe("computeSurpriseScores", () => {
  it("returns correct structural score (actual_edges / expected_edges)", () => {
    // size_a=2, size_b=2, globalDensity=0.5 → expected = 2*2*0.5 = 2, actual = 2
    // structural_score = 2/2 = 1.0
    const results = computeSurpriseScores(
      [communityA, communityB],
      crossEdgesAB,
      [],
      0.5,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.structural_score).toBeCloseTo(1.0);
  });

  it("returns correct temporal score from jaccard pairs", () => {
    // max jaccard across A-B pairs = 0.8
    const results = computeSurpriseScores(
      [communityA, communityB],
      crossEdgesAB,
      coChangePairsAB,
      0.5,
    );
    expect(results[0]!.temporal_score).toBeCloseTo(0.8);
  });

  it("combined score = 0.6 * structural + 0.4 * temporal", () => {
    // structural=1.0, temporal=0.8 → combined = 0.6*1.0 + 0.4*0.8 = 0.92
    const results = computeSurpriseScores(
      [communityA, communityB],
      crossEdgesAB,
      coChangePairsAB,
      0.5,
    );
    expect(results[0]!.combined_score).toBeCloseTo(0.92);
  });

  it("empty communities input returns empty array", () => {
    const results = computeSurpriseScores([], [], [], 0.1);
    expect(results).toEqual([]);
  });

  it("division by zero (0 actual / 0 expected) returns score 0, not NaN", () => {
    // globalDensity=0 → denominator = size_a * size_b * 0 = 0
    const results = computeSurpriseScores(
      [communityA, communityB],
      crossEdgesAB,
      [],
      0,
    );
    expect(results[0]!.structural_score).toBe(0);
    expect(Number.isNaN(results[0]!.structural_score)).toBe(false);
  });

  it("results sorted by combined_score descending", () => {
    // A-B: 2 edges, density=0.25 → structural = 2/(2*2*0.25) = 2/1 = 2.0 → combined high
    // A-C: 1 edge, density=0.25 → structural = 1/(2*1*0.25) = 1/0.5 = 2.0 → same structural
    // Use coChange to differentiate: A-B has temporal=0.8, A-C has none (temporal=0)
    const edgesAC: CrossEdge[] = [
      { from_community: "A", to_community: "C", from_file: "a1.ts", to_file: "c1.ts" },
    ];
    const results = computeSurpriseScores(
      [communityA, communityB, communityC],
      [...crossEdgesAB, ...edgesAC],
      coChangePairsAB,
      0.25,
    );
    expect(results.length).toBeGreaterThan(1);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.combined_score).toBeGreaterThanOrEqual(
        results[i + 1]!.combined_score,
      );
    }
  });

  it("example_files populated from highest-jaccard cross-boundary file pair", () => {
    // coChangePairsAB has jaccard 0.5 (a1/b1) and 0.8 (a2/b2) — highest is a2/b2
    const results = computeSurpriseScores(
      [communityA, communityB],
      crossEdgesAB,
      coChangePairsAB,
      0.5,
    );
    expect(results[0]!.example_files).toEqual(["a2.ts", "b2.ts"]);
  });
});
