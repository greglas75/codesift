import { describe, it, expect, vi, beforeEach } from "vitest";
import { findClones } from "../../src/tools/clone-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock getCodeIndex — I/O boundary (reads from storage)
// ---------------------------------------------------------------------------

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(
  overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "name" | "file" | "source">,
): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 20,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 0,
  };
}

/** Body of 15 normalized lines — enough to exceed default min_lines=10 */
const SHARED_BODY = `
  const items = [];
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      items.push({ id: i, value: i * 10 });
    } else {
      items.push({ id: i, value: i * 5 });
    }
  }
  const filtered = items.filter(x => x.value > 50);
  const mapped = filtered.map(x => x.value);
  const reduced = mapped.reduce((a, b) => a + b, 0);
  return reduced;
`;

/** Slightly different body — should still be detected as near-match */
const NEAR_BODY = `
  const items = [];
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      items.push({ id: i, value: i * 10 });
    } else {
      items.push({ id: i, value: i * 5 });
    }
  }
  const filtered = items.filter(x => x.value > 100);
  const sorted = filtered.sort((a, b) => b.value - a.value);
  const total = sorted.reduce((a, b) => a + b.value, 0);
  return total;
`;

/** Completely different function body */
const UNIQUE_BODY = `
  if (!name) throw new Error("name required");
  const greeting = "Hello, " + name;
  return greeting.toUpperCase();
`;

// ---------------------------------------------------------------------------
// findClones — Pre-Extraction Behavioral Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findClones", () => {
  // -- Error Cases ----------------------------------------------------------

  describe("Error Cases", () => {
    it("throws when repo is not found", async () => {
      mockGetCodeIndex.mockResolvedValue(null);

      await expect(findClones("nonexistent/repo")).rejects.toThrow(
        'Repository "nonexistent/repo" not found',
      );
    });
  });

  // -- Happy Path -----------------------------------------------------------

  describe("Happy Path", () => {
    it("detects exact clones with identical source", async () => {
      const symA = makeSymbol({
        name: "calcA",
        file: "src/a.ts",
        source: `function calcA() {${SHARED_BODY}}`,
        start_line: 1,
        end_line: 20,
      });
      const symB = makeSymbol({
        name: "calcB",
        file: "src/b.ts",
        source: `function calcB() {${SHARED_BODY}}`,
        start_line: 1,
        end_line: 20,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result.clones.length).toBe(1);
      expect(result.clones[0]!.similarity).toBeGreaterThanOrEqual(0.9);
      expect(result.clones[0]!.symbol_a.name).toBe("calcA");
      expect(result.clones[0]!.symbol_b.name).toBe("calcB");
      expect(result.scanned_symbols).toBe(2);
      expect(result.threshold).toBe(0.7);
    });

    it("detects near-matches with similar but not identical source", async () => {
      const symA = makeSymbol({
        name: "processA",
        file: "src/a.ts",
        source: `function processA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "processB",
        file: "src/b.ts",
        source: `function processB() {${NEAR_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      const result = await findClones("test", { min_similarity: 0.5, min_lines: 5 });

      expect(result.clones.length).toBeGreaterThanOrEqual(1);
      const clone = result.clones.find(
        (c) =>
          (c.symbol_a.name === "processA" && c.symbol_b.name === "processB") ||
          (c.symbol_a.name === "processB" && c.symbol_b.name === "processA"),
      );
      expect(clone).toBeDefined();
      expect(clone!.similarity).toBeGreaterThan(0.5);
      expect(clone!.similarity).toBeLessThan(1.0);
      expect(clone!.shared_lines).toBeGreaterThan(0);
    });

    it("returns output shape with correct fields", async () => {
      const symA = makeSymbol({
        name: "fnA",
        file: "src/a.ts",
        source: `function fnA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "fnB",
        file: "src/b.ts",
        source: `function fnB() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result).toHaveProperty("clones");
      expect(result).toHaveProperty("scanned_symbols");
      expect(result).toHaveProperty("threshold");

      const clone = result.clones[0]!;
      expect(clone.symbol_a).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          kind: expect.any(String),
          file: expect.any(String),
          start_line: expect.any(Number),
          end_line: expect.any(Number),
        }),
      );
      expect(typeof clone.similarity).toBe("number");
      expect(typeof clone.shared_lines).toBe("number");
    });
  });

  // -- Filtering ------------------------------------------------------------

  describe("Filtering", () => {
    it("excludes non-analyzable kinds (interface, type, variable)", async () => {
      const fnSym = makeSymbol({
        name: "myFunc",
        file: "src/a.ts",
        kind: "function",
        source: `function myFunc() {${SHARED_BODY}}`,
      });
      const ifaceSym = makeSymbol({
        name: "MyInterface",
        file: "src/b.ts",
        kind: "interface",
        source: `interface MyInterface {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([fnSym, ifaceSym]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      // Only 1 analyzable symbol (function), so no pairs possible
      expect(result.scanned_symbols).toBe(1);
      expect(result.clones.length).toBe(0);
    });

    it("excludes test files by default", async () => {
      const prodSym = makeSymbol({
        name: "calcProd",
        file: "src/calc.ts",
        source: `function calcProd() {${SHARED_BODY}}`,
      });
      const testSym = makeSymbol({
        name: "calcTest",
        file: "src/calc.test.ts",
        source: `function calcTest() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([prodSym, testSym]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result.scanned_symbols).toBe(1);
      expect(result.clones.length).toBe(0);
    });

    it("includes test files when include_tests=true", async () => {
      const prodSym = makeSymbol({
        name: "calcProd",
        file: "src/calc.ts",
        source: `function calcProd() {${SHARED_BODY}}`,
      });
      const testSym = makeSymbol({
        name: "calcTest",
        file: "src/calc.test.ts",
        source: `function calcTest() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([prodSym, testSym]));

      const result = await findClones("test", {
        min_similarity: 0.7,
        min_lines: 5,
        include_tests: true,
      });

      expect(result.scanned_symbols).toBe(2);
      expect(result.clones.length).toBe(1);
    });

    it("filters by file_pattern", async () => {
      const symA = makeSymbol({
        name: "svcA",
        file: "src/services/a.ts",
        source: `function svcA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "svcB",
        file: "src/services/b.ts",
        source: `function svcB() {${SHARED_BODY}}`,
      });
      const symC = makeSymbol({
        name: "utilC",
        file: "src/utils/c.ts",
        source: `function utilC() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB, symC]));

      const result = await findClones("test", {
        min_similarity: 0.7,
        min_lines: 5,
        file_pattern: "services",
      });

      // Only services/a.ts and services/b.ts match
      expect(result.scanned_symbols).toBe(2);
      expect(result.clones.length).toBe(1);
    });

    it("excludes symbols shorter than min_lines after normalization", async () => {
      const shortSym = makeSymbol({
        name: "tiny",
        file: "src/a.ts",
        source: "function tiny() { return 1; }",
      });
      const longSym = makeSymbol({
        name: "longer",
        file: "src/b.ts",
        source: `function longer() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([shortSym, longSym]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 10 });

      // Only 1 symbol exceeds min_lines
      expect(result.scanned_symbols).toBe(1);
      expect(result.clones.length).toBe(0);
    });

    it("excludes symbols without source", async () => {
      const withSource = makeSymbol({
        name: "withSrc",
        file: "src/a.ts",
        source: `function withSrc() {${SHARED_BODY}}`,
      });
      const noSource = makeSymbol({
        name: "noSrc",
        file: "src/b.ts",
        source: undefined as unknown as string,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([withSource, noSource]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result.scanned_symbols).toBe(1);
    });
  });

  // -- Similarity Thresholds ------------------------------------------------

  describe("Similarity Thresholds", () => {
    it("does not detect unique functions as clones", async () => {
      const symA = makeSymbol({
        name: "calcA",
        file: "src/a.ts",
        source: `function calcA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "greetB",
        file: "src/b.ts",
        source: `function greetB(name: string) {${UNIQUE_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 3 });

      expect(result.clones.length).toBe(0);
    });

    it("respects custom min_similarity threshold", async () => {
      const symA = makeSymbol({
        name: "processA",
        file: "src/a.ts",
        source: `function processA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "processB",
        file: "src/b.ts",
        source: `function processB() {${NEAR_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      // With high threshold: might not detect near-matches
      const strict = await findClones("test", { min_similarity: 0.99, min_lines: 5 });
      // With low threshold: should detect near-matches
      const relaxed = await findClones("test", { min_similarity: 0.3, min_lines: 5 });

      expect(relaxed.clones.length).toBeGreaterThanOrEqual(strict.clones.length);
    });
  });

  // -- Edge Cases -----------------------------------------------------------

  describe("Edge Cases", () => {
    it("returns empty clones for index with no symbols", async () => {
      mockGetCodeIndex.mockResolvedValue(makeIndex([]));

      const result = await findClones("test");

      expect(result.clones).toEqual([]);
      expect(result.scanned_symbols).toBe(0);
      expect(result.threshold).toBe(0.7); // default
    });

    it("returns empty clones when only one analyzable symbol exists", async () => {
      const single = makeSymbol({
        name: "onlyOne",
        file: "src/a.ts",
        source: `function onlyOne() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([single]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result.scanned_symbols).toBe(1);
      expect(result.clones.length).toBe(0);
    });

    it("does not report self-matches (same file + same start_line)", async () => {
      // Two symbols at same location (edge case in index)
      const sym = makeSymbol({
        name: "fn",
        file: "src/a.ts",
        source: `function fn() {${SHARED_BODY}}`,
        start_line: 1,
        end_line: 20,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([sym, { ...sym, name: "fn2" }]));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      // Should skip self-match (same file + same start_line)
      expect(result.clones.length).toBe(0);
    });

    it("uses default options when none provided", async () => {
      const symA = makeSymbol({
        name: "calcA",
        file: "src/a.ts",
        source: `function calcA() {${SHARED_BODY}}`,
      });
      const symB = makeSymbol({
        name: "calcB",
        file: "src/b.ts",
        source: `function calcB() {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB]));

      const result = await findClones("test");

      // Defaults: min_similarity=0.7, min_lines=10, include_tests=false
      expect(result.threshold).toBe(0.7);
      expect(result.clones.length).toBe(1);
    });

    it("caps results at MAX_CLONES (50)", async () => {
      // Create 60 identical functions across different files
      const symbols: CodeSymbol[] = [];
      for (let i = 0; i < 60; i++) {
        symbols.push(
          makeSymbol({
            name: `fn${i}`,
            file: `src/file${i}.ts`,
            source: `function fn${i}() {${SHARED_BODY}}`,
            start_line: 1,
            end_line: 20,
          }),
        );
      }

      mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));

      const result = await findClones("test", { min_similarity: 0.7, min_lines: 5 });

      expect(result.clones.length).toBeLessThanOrEqual(50);
    });

    it("sorts clones by similarity descending", async () => {
      // Three symbols: A=B exact, A~C near-match
      const symA = makeSymbol({
        name: "fnA",
        file: "src/a.ts",
        source: `function fnA() {${SHARED_BODY}}`,
        start_line: 1,
      });
      const symB = makeSymbol({
        name: "fnB",
        file: "src/b.ts",
        source: `function fnB() {${SHARED_BODY}}`,
        start_line: 1,
      });
      const symC = makeSymbol({
        name: "fnC",
        file: "src/c.ts",
        source: `function fnC() {${NEAR_BODY}}`,
        start_line: 1,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([symA, symB, symC]));

      const result = await findClones("test", { min_similarity: 0.3, min_lines: 5 });

      if (result.clones.length >= 2) {
        for (let i = 1; i < result.clones.length; i++) {
          expect(result.clones[i]!.similarity).toBeLessThanOrEqual(
            result.clones[i - 1]!.similarity,
          );
        }
      }
    });

    it("handles methods and classes as analyzable kinds", async () => {
      const method = makeSymbol({
        name: "doWork",
        file: "src/a.ts",
        kind: "method",
        source: `doWork() {${SHARED_BODY}}`,
      });
      const cls = makeSymbol({
        name: "Worker",
        file: "src/b.ts",
        kind: "class",
        source: `class Worker {${SHARED_BODY}}`,
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([method, cls]));

      const result = await findClones("test", { min_similarity: 0.5, min_lines: 5 });

      // Both should be scanned (method and class are analyzable)
      expect(result.scanned_symbols).toBe(2);
    });
  });

  // -- Normalization Behavior -----------------------------------------------

  describe("Normalization", () => {
    it("treats functions as clones despite different indentation", async () => {
      // Same code, different leading whitespace (normalizer trims + collapses \s+)
      const noIndent = makeSymbol({
        name: "noIndentFn",
        file: "src/a.ts",
        source:
          "function noIndentFn() {\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nconst a = z * 2;\nconst b = a + 1;\nconst c = b - 3;\nconst d = c / 2;\nconst e = d % 3;\nconst f = e + 10;\nreturn f;\n}",
      });
      const indented = makeSymbol({
        name: "indentedFn",
        file: "src/b.ts",
        source:
          "function indentedFn() {\n    const x = 1;\n    const y = 2;\n    const z = x + y;\n    const a = z * 2;\n    const b = a + 1;\n    const c = b - 3;\n    const d = c / 2;\n    const e = d % 3;\n    const f = e + 10;\n    return f;\n}",
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([noIndent, indented]));

      const result = await findClones("test", { min_similarity: 0.9, min_lines: 5 });

      expect(result.clones.length).toBe(1);
      expect(result.clones[0]!.similarity).toBeGreaterThanOrEqual(0.9);
    });

    it("treats functions as clones despite single-line comment differences", async () => {
      // Same code lines, but one has // comments interspersed
      const withComments = makeSymbol({
        name: "fnWithComments",
        file: "src/a.ts",
        source:
          "function fnWithComments() {\n// step 1\nconst a = 1;\n// step 2\nconst b = 2;\nconst c = a + b;\nconst d = c * 2;\nconst e = d + 1;\nconst f = e - 3;\nconst g = f / 2;\nreturn g;\n}",
      });
      const noComments = makeSymbol({
        name: "fnNoComments",
        file: "src/b.ts",
        source:
          "function fnNoComments() {\nconst a = 1;\nconst b = 2;\nconst c = a + b;\nconst d = c * 2;\nconst e = d + 1;\nconst f = e - 3;\nconst g = f / 2;\nreturn g;\n}",
      });

      mockGetCodeIndex.mockResolvedValue(makeIndex([withComments, noComments]));

      // Comments are stripped by normalizer, so functions should match
      // But hash will differ (comment-stripped vs original), so this is a near-match
      const result = await findClones("test", { min_similarity: 0.8, min_lines: 5 });

      expect(result.clones.length).toBeGreaterThanOrEqual(1);
    });
  });
});
