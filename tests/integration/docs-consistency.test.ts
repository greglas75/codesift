import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

const WORKSPACE_TOOLS = [
  "list_workspaces",
  "workspace_graph",
  "affected_workspaces",
  "workspace_boundaries",
];

const DOCS_FILES = [
  "rules/codesift.md",
  "rules/codex.md",
  "rules/gemini.md",
  "CLAUDE.md",
  "README.md",
  "src/instructions.ts",
];

describe("docs consistency (Task 18a/18b)", () => {
  it("CODESIFT_INSTRUCTIONS in src/instructions.ts mentions all four workspace tools", () => {
    const text = readFileSync(join(REPO_ROOT, "src/instructions.ts"), "utf-8");
    for (const tool of WORKSPACE_TOOLS) {
      expect(text, `instructions.ts must mention ${tool}`).toContain(tool);
    }
    // workspace= keyword for framework tool param documented somewhere
    expect(text).toMatch(/workspace=/);
  });

  it("rule files mention all four workspace tools", () => {
    for (const rel of ["rules/codesift.md", "rules/codex.md", "rules/gemini.md"]) {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf-8");
      for (const tool of WORKSPACE_TOOLS) {
        expect(text, `${rel} must mention ${tool}`).toContain(tool);
      }
    }
  });

  it("tool-count claim is consistent across docs (after +4 monorepo tools)", () => {
    const counts = new Map<string, string>();
    for (const rel of DOCS_FILES) {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf-8");
      // Match either "150 tools" or "150 MCP tools"
      const match = text.match(/(\d{3})\s+(?:MCP\s+)?tools/);
      if (match) counts.set(rel, match[1]!);
    }
    // All matched files agree on the same numeric count
    const uniqueCounts = new Set(counts.values());
    expect(uniqueCounts.size, `tool counts diverge across docs: ${JSON.stringify([...counts])}`).toBe(1);
  });
});
