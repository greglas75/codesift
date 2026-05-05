import { describe, it, expect } from "vitest";
import { staleToMcpError } from "../../src/tools/_helpers.js";

describe("staleToMcpError", () => {
  it("produces MCP isError envelope with text content", () => {
    const result = staleToMcpError({
      reason: "extractor_version_mismatch",
      expected_version: "3.0.0",
      actual_version: "2.1.0",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toMatch(/extractor_version_mismatch/);
    expect(result.content[0]?.text).toMatch(/expected 3\.0\.0/);
    expect(result.content[0]?.text).toMatch(/got 2\.1\.0/);
    expect(result.content[0]?.text).toMatch(/index_folder/);
  });

  it("preserves arbitrary reason strings", () => {
    const result = staleToMcpError({
      reason: "schema_corruption",
      expected_version: "v1",
      actual_version: "v0",
    });
    expect(result.content[0]?.text).toContain("schema_corruption");
  });

  it("names the mismatching language when provided", () => {
    const result = staleToMcpError({
      reason: "extractor_version_mismatch",
      language: "python",
      expected_version: "1.1.0",
      actual_version: "1.0.0",
    });
    expect(result.content[0]?.text).toContain("python expected 1.1.0");
    expect(result.content[0]?.text).toContain("got 1.0.0");
  });

  it("includes mismatch_detail when present", () => {
    const result = staleToMcpError({
      reason: "extractor_version_mismatch",
      language: "typescript",
      expected_version: "3.0.0",
      actual_version: "2.1.0",
      mismatch_detail:
        "python: expected 1.0.0, got 0.9.0; php: expected 2.0.0, got missing",
    });
    expect(result.content[0]?.text).toContain("Also:");
    expect(result.content[0]?.text).toContain("python:");
  });
});
