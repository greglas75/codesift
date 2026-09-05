// How long `git log --numstat` is allowed to take, scaled to the window asked for.
//
// It was a flat 30 s. Measured on tgm-survey-platform (11,167 commits in 180 days): the command
// takes 13.0 s and yields 4.9 MB on a quiet machine, and exceeds 30 s when it is not. On failure the
// churn map comes back empty and the tool reports "no hotspots found" — for a repository with six
// months of dense history.
import { describe, it, expect } from "vitest";
import { gitLogTimeoutMsForTesting } from "../../src/tools/hotspot-tools.js";

describe("git log timeout", () => {
  it("gives a six-month window more than the 30 s that was failing", () => {
    // 13 s measured idle; the failures happened under load, so the headroom is the point.
    expect(gitLogTimeoutMsForTesting(180)).toBeGreaterThan(60_000);
  });

  it("never drops below the old floor for a short window", () => {
    expect(gitLogTimeoutMsForTesting(1)).toBe(30_000);
    expect(gitLogTimeoutMsForTesting(7)).toBe(30_000);
  });

  it("is capped, because past some point the window is simply too large for the repository", () => {
    expect(gitLogTimeoutMsForTesting(3650)).toBe(180_000);
  });

  it("scales with the window rather than jumping to one bigger constant", () => {
    // The cost is proportional to the window; a ceiling generous enough for a year would be an
    // absurd wait on a two-week query.
    expect(gitLogTimeoutMsForTesting(90)).toBeLessThan(gitLogTimeoutMsForTesting(180));
  });
});
