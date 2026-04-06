import { describe, it, expect } from "vitest";
import { discoverTools, getToolDefinitions } from "../../src/register-tools.js";

describe("discoverTools", () => {
  it("returns matches for keyword query", () => {
    const result = discoverTools("dead code");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.name).toBe("find_dead_code");
  });

  it("filters by category", () => {
    const result = discoverTools("", "analysis");
    expect(result.matches.length).toBeGreaterThan(0);
    for (const m of result.matches) {
      expect(m.category).toBe("analysis");
    }
  });

  it("returns all categories", () => {
    const result = discoverTools("anything");
    expect(result.categories).toContain("analysis");
    expect(result.categories).toContain("lsp");
    expect(result.categories).toContain("security");
    expect(result.categories).toContain("graph");
  });

  it("marks core tools correctly", () => {
    const result = discoverTools("search");
    const searchSymbols = result.matches.find((m) => m.name === "search_symbols");
    expect(searchSymbols?.is_core).toBe(true);
    const searchPatterns = result.matches.find((m) => m.name === "search_patterns");
    if (searchPatterns) {
      expect(searchPatterns.is_core).toBe(true);
    }
  });

  it("ranks name matches higher", () => {
    const result = discoverTools("rename");
    expect(result.matches[0]!.name).toBe("rename_symbol");
  });

  it("returns total_tools count", () => {
    const result = discoverTools("test");
    expect(result.total_tools).toBeGreaterThanOrEqual(40);
  });
});

describe("getToolDefinitions", () => {
  it("returns all tool definitions with categories", () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(40);
    // All tools should have categories
    for (const def of defs) {
      expect(def.category).toBeDefined();
      expect(def.searchHint).toBeDefined();
    }
  });
});
