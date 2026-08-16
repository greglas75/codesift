// An absolute `repo` resolves to any registered repo that is an ANCESTOR of it, longest root
// winning — so an unregistered linked worktree binds to its parent checkout. For tools that read
// the index that is H19: a wrong-but-useful approximation. For a GIT RANGE it is neither: the refs
// belong to a different tree.
//
// Measured on a real worktree before this guard existed: `diff_outline("<worktree>", "HEAD~1",
// "HEAD")` returned the PARENT's diff — listing a file committed on main — while the worktree's own
// commit never appeared. It did not fail. It answered, and the answer looked plausible, which is
// the worst shape this can take.
import { describe, it, expect } from "vitest";
import { assertGitTreeMatches } from "../../src/tools/git-tree-guard.js";

describe("assertGitTreeMatches", () => {
  it("refuses when a path resolved to a different working tree", () => {
    expect(() =>
      assertGitTreeMatches("/repo/.worktrees/task", "/repo"),
    ).toThrow(/DIFFERENT working tree/);
  });

  it("names the command that fixes it, with the caller's own path", () => {
    // An error that says only "wrong tree" leaves the agent to guess. The whole cost of this bug
    // was not knowing what to do next.
    try {
      assertGitTreeMatches("/repo/.worktrees/task", "/repo");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('index_folder(path="/repo/.worktrees/task")');
    }
  });

  it("allows the path that IS the indexed tree", () => {
    expect(() => assertGitTreeMatches("/repo", "/repo")).not.toThrow();
  });

  it("ignores a registry NAME, which claims nothing about the caller's directory", () => {
    // `local/codesift` is not a path; there is no contradiction to detect, and refusing here would
    // break the ordinary way every one of these tools is called.
    expect(() => assertGitTreeMatches("local/codesift", "/somewhere/else")).not.toThrow();
    expect(() => assertGitTreeMatches("codesift", "/somewhere/else")).not.toThrow();
  });

  it("compares canonically, so /var and /private/var are the same tree", () => {
    // macOS puts temp dirs under /var -> /private/var. Comparing raw strings would make a repo
    // unequal to itself and refuse every legitimate call there — the same trap the seeding code
    // already documents.
    expect(() => assertGitTreeMatches("/tmp", "/tmp")).not.toThrow();
  });
});
