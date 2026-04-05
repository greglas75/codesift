import { describe, it, expect } from "vitest";
import { formatTable } from "../../src/formatters.js";

describe("formatTable", () => {
  it("aligns columns with header and separator", () => {
    const result = formatTable(["Name", "Score"], [["foo", "99"], ["barbaz", "1"]]);
    const lines = result.split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 data rows
    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("Score");
    expect(lines[1]).toMatch(/^-+\s+-+$/); // dash separator
    expect(lines[2]).toContain("foo");
    expect(lines[3]).toContain("barbaz");
    // Columns should be aligned - all lines same structure
    const nameColEnd = lines[0].indexOf("Score");
    expect(nameColEnd).toBeGreaterThan(4);
    expect(lines[2].indexOf("99")).toBe(lines[0].indexOf("Score"));
  });

  it("returns header + separator for empty rows", () => {
    const result = formatTable(["A", "B"], []);
    const lines = result.split("\n");
    expect(lines.length).toBe(2); // header + separator only
    expect(lines[0]).toContain("A");
    expect(lines[1]).toMatch(/^-+/);
  });

  it("truncates cells exceeding maxColWidth", () => {
    const longValue = "a".repeat(50);
    const result = formatTable(["Col"], [[longValue]], { maxColWidth: 20 });
    const lines = result.split("\n");
    expect(lines[2].trim().length).toBeLessThanOrEqual(20);
    expect(lines[2]).toContain("...");
  });

  it("handles mismatched column counts", () => {
    // Fewer cols: pad with empty
    const result1 = formatTable(["A", "B", "C"], [["x"]]);
    expect(result1).toContain("x");
    // More cols: truncate to header count
    const result2 = formatTable(["A"], [["x", "y", "z"]]);
    const dataLine = result2.split("\n")[2];
    expect(dataLine.trim()).toBe("x");
  });
});
