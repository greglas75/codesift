import { describe, it, expect } from "vitest";
import type { GitCommit } from "../../../src/tools/journal-git-client.js";
import {
  detectPhases,
  parsePhaseOverridesYAML,
  PhaseOverridesParseError,
} from "../../../src/tools/journal-phase-detector.js";

// ---------------------------------------------------------------------------
// Helpers for constructing literal GitCommit objects
// ---------------------------------------------------------------------------
function makeCommit(
  sha: string,
  date: string,
  subject: string,
  parentShas: string[] = ["aaa"],
  refs: string[] = [],
): GitCommit {
  return { sha, date, authorName: "Test User", subject, parentShas, refs };
}

// ---------------------------------------------------------------------------
// (a) Tag-based boundary
// ---------------------------------------------------------------------------
describe("detectPhases – tag boundary", () => {
  it("splits phases at a tagged commit (v1.0.0 ref ends one phase)", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: initial"),
      makeCommit("sha2", "2026-04-02T10:00:00Z", "chore: release", ["sha1"], [
        "HEAD -> main",
        "tag: v1.0.0",
      ]),
      makeCommit("sha3", "2026-04-03T10:00:00Z", "fix: post-release", ["sha2"]),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(2);
    // First phase ends with the tagged commit
    expect(phases[0]!.commits.map((c) => c.sha)).toContain("sha2");
    // Second phase contains the post-release commit
    expect(phases[1]!.commits.map((c) => c.sha)).toContain("sha3");
  });
});

// ---------------------------------------------------------------------------
// (b) Merge-based boundary
// ---------------------------------------------------------------------------
describe("detectPhases – merge boundary", () => {
  it("splits phases when a commit has 2 parent SHAs (merge commit)", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: feature work", ["aaa"]),
      makeCommit("sha2", "2026-04-02T10:00:00Z", "Merge branch 'feature'", [
        "sha1",
        "bbb",
      ]),
      makeCommit("sha3", "2026-04-03T10:00:00Z", "fix: after merge", ["sha2"]),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(2);
    expect(phases[0]!.commits.map((c) => c.sha)).toContain("sha2");
    expect(phases[1]!.commits.map((c) => c.sha)).toContain("sha3");
  });
});

// ---------------------------------------------------------------------------
// (c) Gap-based boundary (>2 days)
// ---------------------------------------------------------------------------
describe("detectPhases – gap boundary", () => {
  it("splits phases when commits are more than 2 days apart", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: day one"),
      makeCommit("sha2", "2026-04-02T10:00:00Z", "fix: day two"),
      // 5-day gap
      makeCommit("sha3", "2026-04-07T10:00:00Z", "feat: after gap"),
      makeCommit("sha4", "2026-04-08T10:00:00Z", "fix: next day"),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(2);
    expect(phases[0]!.commits.map((c) => c.sha)).toEqual(["sha1", "sha2"]);
    expect(phases[1]!.commits.map((c) => c.sha)).toEqual(["sha3", "sha4"]);
  });

  it("does NOT split commits that are exactly 2 days apart (boundary is >2)", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: day one"),
      makeCommit("sha2", "2026-04-03T10:00:00Z", "feat: two days later"),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) YAML override wins
// ---------------------------------------------------------------------------
describe("detectPhases – YAML override", () => {
  it("applies manual override: matching date produces override slug/title with source=manual", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-10T10:00:00Z", "feat: before"),
      makeCommit("sha2", "2026-04-11T10:00:00Z", "feat: wiki day"),
      makeCommit("sha3", "2026-04-12T10:00:00Z", "feat: after"),
    ];

    const phases = detectPhases(commits, [
      { date: "2026-04-11", slug: "wiki-v2", title: "Wiki v2 Launch" },
    ]);

    const manualPhase = phases.find((p) => p.source === "manual");
    expect(manualPhase).toBeDefined();
    expect(manualPhase!.slug).toBe("wiki-v2");
    expect(manualPhase!.title).toBe("Wiki v2 Launch");
    expect(manualPhase!.commits.map((c) => c.sha)).toContain("sha2");
  });
});

// ---------------------------------------------------------------------------
// (e) Multi-day tiebreaker: straddle attaches to LATER phase
// ---------------------------------------------------------------------------
describe("detectPhases – tiebreaker", () => {
  it("attaches boundary commit to the LATER phase deterministically", () => {
    // sha2 is on the exact boundary date between two gap-split groups.
    // We feed commits in order; the boundary commit (sha2) should go to the later phase.
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: early"),
      // sha2 is the first commit of the new (later) phase after a gap
      makeCommit("sha2", "2026-04-05T10:00:00Z", "feat: boundary commit"),
      makeCommit("sha3", "2026-04-06T10:00:00Z", "feat: next day"),
    ];

    const phases = detectPhases(commits);
    // Gap between sha1 (Apr 1) and sha2 (Apr 5) = 4 days > 2
    expect(phases).toHaveLength(2);
    // sha2 is the FIRST commit of the later phase, not the last of the earlier
    expect(phases[1]!.commits.map((c) => c.sha)).toContain("sha2");
    expect(phases[0]!.commits.map((c) => c.sha)).not.toContain("sha2");
  });
});

// ---------------------------------------------------------------------------
// (f) Unclassified fallback
// ---------------------------------------------------------------------------
describe("detectPhases – unclassified fallback", () => {
  it("returns a single phase with slug 'unclassified' when no heuristic applies", () => {
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat: one"),
      makeCommit("sha2", "2026-04-02T10:00:00Z", "fix: two"),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.slug).toBe("unclassified");
    expect(phases[0]!.source).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// (g) Slug collision → numeric suffix
// ---------------------------------------------------------------------------
describe("detectPhases – slug collision", () => {
  it("deduplicates identical slugs by appending -2, -3 etc.", () => {
    // Two gap-split phases whose subjects both map to "feat-work" via scope extraction
    // We use matching subjects so auto-titling produces the same slug.
    // Force two phases via a >2 day gap, both with identical conventional-commit scopes.
    const commits: GitCommit[] = [
      makeCommit("sha1", "2026-04-01T10:00:00Z", "feat(alpha): work"),
      makeCommit("sha2", "2026-04-02T10:00:00Z", "feat(alpha): more work"),
      // >2 day gap
      makeCommit("sha3", "2026-04-06T10:00:00Z", "feat(alpha): new sprint"),
      makeCommit("sha4", "2026-04-07T10:00:00Z", "feat(alpha): last day"),
    ];

    const phases = detectPhases(commits);
    expect(phases).toHaveLength(2);
    const slugs = phases.map((p) => p.slug);
    // Second phase must have a suffix (e.g., "alpha-2" or "unclassified-2")
    expect(slugs[0]).not.toBe(slugs[1]);
    // The second slug must end with a numeric suffix
    expect(slugs[1]).toMatch(/-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// (h) YAML parse error — typed PhaseOverridesParseError with .line
// ---------------------------------------------------------------------------
describe("parsePhaseOverridesYAML", () => {
  it("parses a well-formed YAML list of overrides", () => {
    const yaml = [
      "- date: 2026-04-11",
      "  slug: wiki-v2",
      "  title: Wiki v2 Launch",
      "- date: 2026-03-15",
      "  slug: foo",
      "  title: Foo Phase",
    ].join("\n");

    const overrides = parsePhaseOverridesYAML(yaml);
    expect(overrides).toHaveLength(2);
    expect(overrides[0]!.slug).toBe("wiki-v2");
    expect(overrides[0]!.title).toBe("Wiki v2 Launch");
    expect(overrides[1]!.slug).toBe("foo");
  });

  it("throws PhaseOverridesParseError with a .line property on malformed YAML", () => {
    // Line 2 is malformed (missing colon separator)
    const malformed = [
      "- date: 2026-04-11",
      "  INVALID LINE NO COLON HERE",
      "  title: Foo",
    ].join("\n");

    let caught: unknown;
    try {
      parsePhaseOverridesYAML(malformed);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PhaseOverridesParseError);
    expect((caught as PhaseOverridesParseError).line).toBeGreaterThan(0);
    expect(typeof (caught as PhaseOverridesParseError).line).toBe("number");
  });

  it("throws PhaseOverridesParseError with correct line number", () => {
    // Line 3 (1-indexed) is bad
    const yaml = [
      "- date: 2026-04-11",
      "  slug: ok",
      "  !!!bad line",
      "  title: Foo",
    ].join("\n");

    let caught: unknown;
    try {
      parsePhaseOverridesYAML(yaml);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PhaseOverridesParseError);
    expect((caught as PhaseOverridesParseError).line).toBe(3);
  });
});
