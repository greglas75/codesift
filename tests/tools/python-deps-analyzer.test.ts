import { describe, it, expect } from "vitest";
import { parseRequirementsTxt, compareVersions } from "../../src/tools/python-deps-analyzer.js";

describe("parseRequirementsTxt", () => {
  it("parses pinned versions", () => {
    const result = parseRequirementsTxt("django==4.2.7\nflask>=3.0\nrequests");
    expect(result).toEqual([
      { name: "django", version: "==4.2.7" },
      { name: "flask", version: ">=3.0" },
      { name: "requests", version: "*" },
    ]);
  });

  it("handles extras syntax", () => {
    const result = parseRequirementsTxt("pydantic[email]>=2.0");
    expect(result[0]).toEqual({ name: "pydantic", version: ">=2.0" });
  });

  it("skips comments and blank lines", () => {
    const content = `
# This is a comment
django==4.2

# another comment
flask==3.0
`;
    expect(parseRequirementsTxt(content)).toHaveLength(2);
  });

  it("skips editable installs and git URLs", () => {
    const content = `
django==4.2
-e ./local-package
git+https://github.com/user/repo.git
https://example.com/pkg.tar.gz
flask==3.0
`;
    const result = parseRequirementsTxt(content);
    expect(result.map((d) => d.name)).toEqual(["django", "flask"]);
  });

  it("strips inline comments", () => {
    const result = parseRequirementsTxt("django==4.2  # LTS version");
    expect(result[0]!.name).toBe("django");
  });
});

describe("compareVersions", () => {
  it("detects current version", () => {
    expect(compareVersions(">=4.2", "4.2.5")).toBe("current");
    expect(compareVersions("==4.2.0", "4.2.0")).toBe("current");
  });

  it("detects minor outdated", () => {
    expect(compareVersions(">=4.2", "4.3.0")).toBe("outdated-minor");
    expect(compareVersions("~=4.2.0", "4.5.2")).toBe("outdated-minor");
  });

  it("detects major outdated", () => {
    expect(compareVersions(">=3.0", "4.2.0")).toBe("outdated-major");
    expect(compareVersions("==2.1", "4.0.0")).toBe("outdated-major");
  });

  it("returns unknown for unparseable constraints", () => {
    expect(compareVersions("", "4.2.0")).toBe("unknown");
    expect(compareVersions("not-a-version", "4.2.0")).toBe("unknown");
  });
});
