// How many differing files are still worth catching up on, rather than re-walking the tree.
//
// This is a pure decision, and it is the whole of the 2026-08-30 fix: a flat ceiling of 3000 was
// measured against a FRESH parent index (parent 14,891 files, worktree 14,405, eleven different).
// Real parent indexes trail the branch by a couple of days, so worktrees cut from `develop`
// differed by ~4,100 files and the seed was declined every time — `seeded from` 0 against
// `seed not usable` 28 in the live logs. The feature had never run once.
import { describe, it, expect } from "vitest";
import { catchUpCeiling } from "../../src/tools/index-tools/worktree-seed.js";

describe("catchUpCeiling", () => {
  it("accepts the case that was being refused in production", () => {
    // The measured shape: a 15,422-file parent index, worktrees differing by 4,034-4,106 files.
    // Full index of one such worktree took 6,412 s; the catch-up path costs less PER FILE than the
    // walk it replaces (283 ms vs 416 ms), so refusing here bought nothing and cost 107 minutes.
    const ceiling = catchUpCeiling(15422);
    expect(ceiling).toBeGreaterThan(4106);
  });

  it("keeps the old flat ceiling as a floor for small trees", () => {
    // Below ~5,000 files a full index is quick, so nothing needs to change there; the floor is what
    // stops the fraction from making a small repo MORE eager than it used to be.
    expect(catchUpCeiling(100)).toBe(3000);
    expect(catchUpCeiling(4000)).toBe(3000);
  });

  it("falls back to the floor when the tree size is unknown", () => {
    // A caller that cannot say how big the seed was must not get an unbounded ceiling by omission —
    // absence of a number is not evidence that the number is large.
    expect(catchUpCeiling(undefined)).toBe(3000);
    expect(catchUpCeiling(0)).toBe(3000);
  });

  it("still leaves an escape hatch for a genuinely diverged worktree", () => {
    // A worktree whose files have nearly all changed is a case where a clean walk is the more
    // predictable answer. The observed case sits at 27% of the tree, so keeping this costs nothing.
    const files = 15422;
    expect(catchUpCeiling(files)).toBeLessThan(files);
  });

  it("scales with the tree rather than staying flat", () => {
    expect(catchUpCeiling(50_000)).toBeGreaterThan(catchUpCeiling(15_422));
  });
});
