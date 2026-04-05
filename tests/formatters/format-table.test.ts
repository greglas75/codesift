import { describe, it, expect } from "vitest";
import { formatTable, formatHotspots, formatComplexity, formatClones } from "../../src/formatters.js";

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

describe("formatTable applied to existing formatters", () => {
  it("formatHotspots produces tabular output", () => {
    const data = {
      hotspots: [
        { file: "src/a.ts", commits: 45, lines_changed: 2300, symbol_count: 10, hotspot_score: 87.5 },
        { file: "src/b.ts", commits: 12, lines_changed: 500, symbol_count: 5, hotspot_score: 23.1 },
      ],
      period: "90d",
    };
    const result = formatHotspots(data);
    expect(result).toContain("period: 90d");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("87.5");
    expect(result).toContain("45");
  });

  it("formatComplexity produces tabular output", () => {
    const data = {
      functions: [
        { name: "foo", kind: "function", file: "src/a.ts", start_line: 1, lines: 50, cyclomatic_complexity: 5, max_nesting_depth: 3 },
      ],
      summary: { avg_complexity: 5, max_complexity: 5, total_functions: 1 },
    };
    const result = formatComplexity(data);
    expect(result).toContain("foo");
    expect(result).toContain("5"); // CC
    expect(result).toContain("avg_complexity=5");
  });

  it("formatClones produces tabular output", () => {
    const data = {
      clones: [{ symbol_a: { name: "fn1", file: "a.ts", start_line: 1 }, symbol_b: { name: "fn2", file: "b.ts", start_line: 5 }, similarity: 0.85, shared_lines: 10 }],
      scanned_symbols: 100,
      threshold: 0.7,
    };
    const result = formatClones(data);
    expect(result).toContain("85%");
    expect(result).toContain("fn1");
    expect(result).toContain("fn2");
  });
});
