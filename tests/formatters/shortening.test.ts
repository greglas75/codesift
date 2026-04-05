import { describe, it, expect } from "vitest";
import {
  formatComplexityCompact,
  formatComplexityCounts,
  formatClonesCompact,
  formatClonesCounts,
  formatHotspotsCompact,
  formatHotspotsCounts,
} from "../../src/formatters-shortening.js";

// ── Helpers ────────────────────────────────────────

function makeComplexityEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `fn${i}`,
    kind: "function",
    file: `src/module${i % 5}.ts`,
    start_line: i * 10 + 1,
    lines: 20 + i,
    cyclomatic_complexity: 5 + (i % 10),
    max_nesting_depth: 2 + (i % 4),
  }));
}

function makeComplexityData(n: number) {
  const functions = makeComplexityEntries(n);
  const avg = Math.round(functions.reduce((s, f) => s + f.cyclomatic_complexity, 0) / n);
  const max = Math.max(...functions.map((f) => f.cyclomatic_complexity));
  return {
    functions,
    summary: { avg_complexity: avg, max_complexity: max, total_functions: n },
  };
}

function makeClonePairs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    symbol_a: { name: `fn${i}a`, file: `src/deeply/nested/path/module${i}.ts`, start_line: i * 10 + 1 },
    symbol_b: { name: `fn${i}b`, file: `src/another/long/path/other${i}.ts`, start_line: i * 10 + 5 },
    similarity: 0.7 + (i % 3) * 0.1,
    shared_lines: 10 + i,
  }));
}

function makeHotspotEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    file: `src/hot${i}.ts`,
    commits: 10 + i,
    lines_changed: 100 + i * 10,
    symbol_count: 5 + i,
    hotspot_score: 50 + i * 2,
  }));
}

// ── formatComplexityCompact ────────────────────────

describe("formatComplexityCompact", () => {
  it("caps output at 25 entries when given 30 functions", () => {
    const data = makeComplexityData(30);
    const result = formatComplexityCompact(data);
    const lines = result.split("\n");
    // header + separator + up to 25 data rows = 27 lines max
    // The table header/separator account for 2 lines; data rows capped at 25
    const dataRows = lines.slice(2); // skip header + separator
    expect(dataRows.length).toBeLessThanOrEqual(25);
  });

  it("uses table format with expected column headers", () => {
    const data = makeComplexityData(5);
    const result = formatComplexityCompact(data);
    expect(result).toContain("CC");
    expect(result).toContain("NAME");
  });

  it("does NOT include a NEST column", () => {
    const data = makeComplexityData(5);
    const result = formatComplexityCompact(data);
    expect(result).not.toContain("NEST");
  });

  it("includes function names and CC values in output", () => {
    const data = makeComplexityData(3);
    const result = formatComplexityCompact(data);
    expect(result).toContain("fn0");
    expect(result).toContain("fn1");
  });
});

// ── formatComplexityCounts ─────────────────────────

describe("formatComplexityCounts", () => {
  it("returns a one-line summary string", () => {
    const data = makeComplexityData(30);
    const result = formatComplexityCounts(data);
    expect(result.split("\n").length).toBe(1);
  });

  it("includes total function count", () => {
    const data = makeComplexityData(30);
    const result = formatComplexityCounts(data);
    expect(result).toContain("30");
  });

  it("includes avg_cc and max_cc labels", () => {
    const data = makeComplexityData(30);
    const result = formatComplexityCounts(data);
    expect(result).toContain("avg_cc=");
    expect(result).toContain("max_cc=");
  });

  it("includes the correct max_cc value", () => {
    const data = makeComplexityData(10);
    const max = data.summary.max_complexity;
    const result = formatComplexityCounts(data);
    expect(result).toContain(`max_cc=${max}`);
  });
});

// ── formatClonesCompact ────────────────────────────

describe("formatClonesCompact", () => {
  it("caps output at 20 entries when given 25 clones", () => {
    const data = { clones: makeClonePairs(25), scanned_symbols: 100, threshold: 0.7 };
    const result = formatClonesCompact(data);
    const lines = result.split("\n");
    // table header + separator = 2 lines, data rows capped at 20
    const dataRows = lines.filter((l) => l.trim().length > 0 && !l.startsWith("-") && !l.startsWith("SIM") && !l.startsWith("scanned"));
    expect(dataRows.length).toBeLessThanOrEqual(20);
  });

  it("uses basenames only (no full path directory components)", () => {
    const data = {
      clones: [makeClonePairs(1)[0]!],
      scanned_symbols: 100,
      threshold: 0.7,
    };
    const result = formatClonesCompact(data);
    // The deeply nested path should show only basename
    expect(result).not.toContain("src/deeply/nested/path/");
    expect(result).toContain("module0.ts");
  });

  it("includes similarity percentage in output", () => {
    const data = { clones: makeClonePairs(3), scanned_symbols: 50, threshold: 0.7 };
    const result = formatClonesCompact(data);
    expect(result).toMatch(/\d+%/);
  });

  it("uses table format", () => {
    const data = { clones: makeClonePairs(3), scanned_symbols: 50, threshold: 0.7 };
    const result = formatClonesCompact(data);
    expect(result).toContain("SIM");
  });
});

// ── formatClonesCounts ─────────────────────────────

describe("formatClonesCounts", () => {
  it("returns a one-line summary string", () => {
    const data = { clones: makeClonePairs(25), scanned_symbols: 100, threshold: 0.7 };
    const result = formatClonesCounts(data);
    expect(result.split("\n").length).toBe(1);
  });

  it("includes total clone pair count", () => {
    const data = { clones: makeClonePairs(25), scanned_symbols: 100, threshold: 0.7 };
    const result = formatClonesCounts(data);
    expect(result).toContain("25");
  });

  it("includes threshold value", () => {
    const data = { clones: makeClonePairs(5), scanned_symbols: 100, threshold: 0.7 };
    const result = formatClonesCounts(data);
    expect(result).toContain("0.7");
  });

  it("includes scanned symbols count", () => {
    const data = { clones: makeClonePairs(5), scanned_symbols: 100, threshold: 0.7 };
    const result = formatClonesCounts(data);
    expect(result).toContain("100");
  });
});

// ── formatHotspotsCompact ──────────────────────────

describe("formatHotspotsCompact", () => {
  it("caps output at 15 entries when given 20 hotspots", () => {
    const data = { hotspots: makeHotspotEntries(20), period: "90d" };
    const result = formatHotspotsCompact(data);
    const lines = result.split("\n");
    // table: header + separator = 2 lines, data rows capped at 15
    const dataRows = lines.slice(2);
    expect(dataRows.length).toBeLessThanOrEqual(15);
  });

  it("uses table format", () => {
    const data = { hotspots: makeHotspotEntries(5), period: "90d" };
    const result = formatHotspotsCompact(data);
    expect(result).toContain("SCORE");
    expect(result).toContain("FILE");
  });

  it("includes hotspot file names", () => {
    const data = { hotspots: makeHotspotEntries(3), period: "90d" };
    const result = formatHotspotsCompact(data);
    expect(result).toContain("hot0");
    expect(result).toContain("hot1");
  });

  it("returns empty message when no hotspots", () => {
    const data = { hotspots: [], period: "90d" };
    const result = formatHotspotsCompact(data);
    expect(result).toContain("no hotspots");
  });
});

// ── formatHotspotsCounts ───────────────────────────

describe("formatHotspotsCounts", () => {
  it("returns a one-line summary string", () => {
    const data = { hotspots: makeHotspotEntries(20), period: "90d" };
    const result = formatHotspotsCounts(data);
    expect(result.split("\n").length).toBe(1);
  });

  it("includes total hotspot count", () => {
    const data = { hotspots: makeHotspotEntries(20), period: "90d" };
    const result = formatHotspotsCounts(data);
    expect(result).toContain("20");
  });

  it("includes period in output", () => {
    const data = { hotspots: makeHotspotEntries(5), period: "90d" };
    const result = formatHotspotsCounts(data);
    expect(result).toContain("90d");
  });

  it("uses 'hotspots' label", () => {
    const data = { hotspots: makeHotspotEntries(5), period: "30d" };
    const result = formatHotspotsCounts(data);
    expect(result.toLowerCase()).toContain("hotspot");
  });
});
