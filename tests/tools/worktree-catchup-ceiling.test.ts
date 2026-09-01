// How many differing files are still worth catching up on, rather than re-walking the tree.
//
// This constant has now been wrong in BOTH directions, and the second time was a regression I
// shipped, so the cases below are the measurements rather than a rule of thumb.
//
// Too low (2026-08-30): a flat 3000 measured against a FRESH parent index. Real parent indexes
// trail the branch, worktrees differed by ~4,100 files, and the seed was declined every time —
// `seeded from` 0 against `seed not usable` 28.
//
// Too high (2026-08-31): raising it to 60% of the tree, on a per-file cost taken from `index_file`
// p90 (283 ms). That distribution is dominated by calls that SHORT-CIRCUIT on an unchanged file.
// The catch-ups the raised ceiling then allowed measured 1.6-7.0 s per changed file:
//   3,778 files -> 9,489 s (158 min) · 778 -> 5,483 s · 772 -> 4,496 s · 356 -> 575 s
// against 416 ms per file for the full walk it replaces. On the 3,778-file case the "optimisation"
// took 158 minutes where the full index takes 107.
import { describe, it, expect } from "vitest";
import { catchUpCeiling } from "../../src/tools/index-tools/worktree-seed.js";

describe("catchUpCeiling", () => {
  it("refuses the catch-ups that measured slower than the walk they replaced", () => {
    // tgm-survey-platform: 15,478 files in the seed, 3,778 changed, 158 minutes.
    expect(catchUpCeiling(15478)).toBeLessThan(3778);
    // rs_admin: 1,055 files, 778 changed, 91 minutes. The old 3000 "floor" admitted the whole tree.
    expect(catchUpCeiling(1055)).toBeLessThan(778);
  });

  it("still accepts a catch-up that is a small fraction of the tree", () => {
    // The case the seed exists for: a worktree a few hundred files off a 15k-file parent.
    expect(catchUpCeiling(15478)).toBeGreaterThan(1000);
    expect(catchUpCeiling(1055)).toBeGreaterThan(50);
  });

  it("keeps a floor so a tiny repository is not forced into a walk for a handful of changes", () => {
    expect(catchUpCeiling(100)).toBe(100);
    expect(catchUpCeiling(300)).toBe(100);
  });

  it("falls back to the floor when the tree size is unknown", () => {
    // Absence of a number is not evidence that the number is large, and the failure this constant
    // has twice produced is an unbounded catch-up, not an unnecessary walk.
    expect(catchUpCeiling(undefined)).toBe(100);
    expect(catchUpCeiling(0)).toBe(100);
  });

  it("scales with the tree rather than staying flat", () => {
    expect(catchUpCeiling(50_000)).toBeGreaterThan(catchUpCeiling(15_478));
  });
});
