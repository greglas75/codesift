import { buildArgsSummary, extractResultChunks } from "../../src/storage/usage-tracker.js";

describe("buildArgsSummary", () => {
  describe("search_text field schema", () => {
    it("captures ranked flag (regression: telemetry blindspot)", () => {
      const s = buildArgsSummary("search_text", { query: "FooBar", ranked: true });
      expect(s["ranked"]).toBe(true);
    });

    it("captures explicit ranked=false", () => {
      const s = buildArgsSummary("search_text", { query: "FooBar", ranked: false });
      expect(s["ranked"]).toBe(false);
    });

    it("captures compact flag", () => {
      const s = buildArgsSummary("search_text", { query: "foo", compact: true });
      expect(s["compact"]).toBe(true);
    });

    it("omits ranked when not passed (so absent != false in logs)", () => {
      const s = buildArgsSummary("search_text", { query: "foo" });
      expect("ranked" in s).toBe(false);
      expect("compact" in s).toBe(false);
    });

    it("preserves all existing search_text fields alongside ranked/compact", () => {
      const s = buildArgsSummary("search_text", {
        query: "foo",
        regex: true,
        context_lines: 2,
        file_pattern: "*.ts",
        max_results: 10,
        group_by_file: true,
        auto_group: false,
        ranked: true,
        compact: false,
      });
      expect(s["query"]).toBe("foo");
      expect(s["regex"]).toBe(true);
      expect(s["context_lines"]).toBe(2);
      expect(s["file_pattern"]).toBe("*.ts");
      expect(s["max_results"]).toBe(10);
      expect(s["group_by_file"]).toBe(true);
      expect(s["auto_group"]).toBe(false);
      expect(s["ranked"]).toBe(true);
      expect(s["compact"]).toBe(false);
    });
  });
});

describe("extractResultChunks", () => {
  it("counts array results", () => {
    expect(extractResultChunks([1, 2, 3])).toBe(3);
  });

  it("counts non-empty lines of formatted-string results", () => {
    const formatted = "src/a.ts:10 function alpha\nsrc/b.ts:20 class Beta\n\nsrc/c.ts:5 type Gamma";
    expect(extractResultChunks(formatted)).toBe(3);
  });

  it("returns 0 for empty strings", () => {
    expect(extractResultChunks("")).toBe(0);
    expect(extractResultChunks("   \n  ")).toBe(0);
  });

  it("returns 0 for common no-result markers", () => {
    expect(extractResultChunks("(no results)")).toBe(0);
    expect(extractResultChunks("No matches.")).toBe(0);
    expect(extractResultChunks("no symbols found for query")).toBe(0);
  });

  it("still handles object results under common keys", () => {
    expect(extractResultChunks({ results: [1, 2] })).toBe(2);
    expect(extractResultChunks({ matches: [] })).toBe(0);
  });
});
