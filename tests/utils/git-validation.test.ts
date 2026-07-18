import { describe, it, expect } from "vitest";
import { buildGitDiffArgs, validateGitRef } from "../../src/utils/git-validation.js";

describe("validateGitRef", () => {
  it("accepts ordinary refs, shas, and range operators", () => {
    for (const ref of ["HEAD", "HEAD~1", "HEAD^", "main", "v1.2.3", "abc1234", "origin/main", "@{upstream}"]) {
      expect(() => validateGitRef(ref)).not.toThrow();
    }
  });

  it("rejects empty and shell-injection refs", () => {
    expect(() => validateGitRef("")).toThrow(/Invalid git ref/);
    expect(() => validateGitRef("HEAD; rm -rf /")).toThrow(/Invalid git ref/);
    expect(() => validateGitRef("$(whoami)")).toThrow(/Invalid git ref/);
  });
});

describe("buildGitDiffArgs (BUG B — WORKING/STAGED pseudo-refs)", () => {
  it("translates until=WORKING to a working-tree diff (since → working tree, no ref..ref)", () => {
    // Root cause: a bare `HEAD..WORKING` is fed to git as an unknown revision and
    // the whole tool errored (impact_analysis 35.7% error rate in telemetry).
    expect(buildGitDiffArgs("HEAD", "WORKING", true)).toEqual(["diff", "--name-only", "HEAD"]);
    expect(buildGitDiffArgs("HEAD", "WORKING", false)).toEqual(["diff", "HEAD"]);
    expect(buildGitDiffArgs("abc1234", "WORKING", true)).toEqual(["diff", "--name-only", "abc1234"]);
  });

  it("translates until=STAGED to a --cached diff (since → index)", () => {
    expect(buildGitDiffArgs("HEAD", "STAGED", true)).toEqual(["diff", "--name-only", "--cached", "HEAD"]);
    expect(buildGitDiffArgs("HEAD", "STAGED", false)).toEqual(["diff", "--cached", "HEAD"]);
  });

  it("builds a normal ref..ref range for two real refs", () => {
    expect(buildGitDiffArgs("HEAD~1", "HEAD", true)).toEqual(["diff", "--name-only", "HEAD~1..HEAD"]);
    expect(buildGitDiffArgs("v1.0", "v2.0", false)).toEqual(["diff", "v1.0..v2.0"]);
  });

  it("still rejects an invalid `since` ref (validation is not bypassed by pseudo-refs)", () => {
    expect(() => buildGitDiffArgs("HEAD; rm -rf /", "WORKING", true)).toThrow(/Invalid git ref/);
    expect(() => buildGitDiffArgs("$(x)", "STAGED", false)).toThrow(/Invalid git ref/);
  });

  it("rejects an invalid `until` ref that is not a pseudo-ref", () => {
    expect(() => buildGitDiffArgs("HEAD", "foo bar", true)).toThrow(/Invalid git ref/);
  });

  it("treats only exact-uppercase WORKING/STAGED as pseudo-refs (documented contract)", () => {
    // lowercase is a valid-looking ref → normal range (fails later at git, not here)
    expect(buildGitDiffArgs("HEAD", "working", true)).toEqual(["diff", "--name-only", "HEAD..working"]);
  });
});
