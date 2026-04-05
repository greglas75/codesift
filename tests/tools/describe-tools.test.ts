import { describe, it, expect } from "vitest";
import { describeTools, getToolDefinitions } from "../../src/register-tools.js";

describe("describeTools", () => {
  it("returns full params for a known tool", () => {
    const result = describeTools(["search_text"]);
    expect(result.tools).toHaveLength(1);
    expect(result.not_found).toHaveLength(0);
    const tool = result.tools[0];
    expect(tool.name).toBe("search_text");
    expect(tool.category).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.is_core).toBe(true);
    expect(tool.params.length).toBeGreaterThan(0);
    // search_text has repo (required) and query (required) params
    const repo = tool.params.find(p => p.name === "repo");
    expect(repo).toBeDefined();
    expect(repo!.required).toBe(true);
    const query = tool.params.find(p => p.name === "query");
    expect(query).toBeDefined();
    expect(query!.required).toBe(true);
    const filePattern = tool.params.find(p => p.name === "file_pattern");
    expect(filePattern).toBeDefined();
    expect(filePattern!.required).toBe(false);
  });

  it("returns not_found for unknown tool", () => {
    const result = describeTools(["nonexistent_tool_xyz"]);
    expect(result.tools).toHaveLength(0);
    expect(result.not_found).toEqual(["nonexistent_tool_xyz"]);
  });

  it("returns partial results for mixed valid/invalid names", () => {
    const result = describeTools(["search_text", "nonexistent_tool_xyz"]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("search_text");
    expect(result.not_found).toEqual(["nonexistent_tool_xyz"]);
  });

  it("returns empty arrays for empty input", () => {
    const result = describeTools([]);
    expect(result.tools).toHaveLength(0);
    expect(result.not_found).toHaveLength(0);
  });

  it("correctly marks non-core tools", () => {
    const result = describeTools(["find_dead_code"]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].is_core).toBe(false);
  });
});
