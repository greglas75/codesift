import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rulesDir = join(process.cwd(), "rules");

describe("rules/ directory content", () => {
  it("rules/codesift.md exists and has header", () => {
    const content = readFileSync(join(rulesDir, "codesift.md"), "utf-8");
    expect(content).toMatch(/^<!-- codesift-rules v/);
    expect(content.length).toBeGreaterThan(500);
    expect(content.length).toBeLessThan(15000);
  });

  it("contains all required sections", () => {
    const content = readFileSync(join(rulesDir, "codesift.md"), "utf-8");
    expect(content).toContain("Tool Mapping");
    expect(content).toContain("ALWAYS");
    expect(content).toContain("NEVER");
    expect(content).toContain("Hint Codes");
    expect(content).toContain("Key Parameters");
  });

  it("rules/codesift.mdc exists with MDC frontmatter", () => {
    const content = readFileSync(join(rulesDir, "codesift.mdc"), "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("codesift-rules");
  });

  it("rules/codex.md exists", () => {
    const content = readFileSync(join(rulesDir, "codex.md"), "utf-8");
    expect(content).toContain("codesift-rules");
    expect(content.length).toBeGreaterThan(500);
  });

  it("rules/gemini.md exists", () => {
    const content = readFileSync(join(rulesDir, "gemini.md"), "utf-8");
    expect(content).toContain("codesift-rules");
    expect(content.length).toBeGreaterThan(500);
  });
});
