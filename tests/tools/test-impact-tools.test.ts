import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("../../src/tools/impact-tools.js", () => ({
  impactAnalysis: vi.fn(),
}));

vi.mock("../../src/tools/coupling-tools.js", () => ({
  computeCoChangePairs: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import {
  computeTestConfidence,
  matchTestFile,
  testImpactAnalysis,
} from "../../src/tools/test-impact-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { impactAnalysis } from "../../src/tools/impact-tools.js";
import { computeCoChangePairs } from "../../src/tools/coupling-tools.js";
import { existsSync } from "node:fs";
import type { CodeIndex, FileEntry, ImpactResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count: 1,
    last_modified: Date.now(),
  };
}

function makeFakeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files: [
      makeFile("src/tools/foo.ts"),
      makeFile("src/tools/bar.ts"),
      makeFile("tests/tools/foo.test.ts"),
      makeFile("tests/tools/bar.test.ts"),
    ],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 4,
    ...overrides,
  };
}

function makeFakeImpactResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    changed_files: ["src/tools/foo.ts"],
    affected_symbols: [],
    affected_tests: [
      { test_file: "tests/tools/foo.test.ts", reason: "imports foo (foo.ts)" },
    ],
    risk_scores: [],
    dependency_graph: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeTestConfidence", () => {
  it("caps at 1.0 with naming match + high jaccard", () => {
    // 0.5 + 0.3 (naming) + 0.2 (min(0.8, 0.2)) = 1.0
    expect(computeTestConfidence(true, 0.8)).toBe(1.0);
  });

  it("returns 0.6 with no naming match and jaccard 0.1", () => {
    // 0.5 + 0.0 + 0.1 = 0.6
    expect(computeTestConfidence(false, 0.1)).toBe(0.6);
  });

  it("returns 0.5 with no naming match and no co-change", () => {
    // 0.5 + 0.0 + 0.0 = 0.5
    expect(computeTestConfidence(false, 0)).toBe(0.5);
  });
});

describe("matchTestFile", () => {
  const testFiles = [
    "tests/tools/foo.test.ts",
    "src/tools/__tests__/bar.test.ts",
    "tests/utils/baz.spec.ts",
  ];

  it("matches src→tests directory with .test extension", () => {
    expect(matchTestFile("src/tools/foo.ts", testFiles)).toBe(
      "tests/tools/foo.test.ts",
    );
  });

  it("matches sibling __tests__ directory", () => {
    expect(matchTestFile("src/tools/bar.ts", testFiles)).toBe(
      "src/tools/__tests__/bar.test.ts",
    );
  });

  it("returns null when no match found", () => {
    expect(matchTestFile("src/tools/unknown.ts", testFiles)).toBeNull();
  });
});

describe("testImpactAnalysis", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns affected tests with naming matches and confidence scores", async () => {
    const fakeIndex = makeFakeIndex();
    vi.mocked(getCodeIndex).mockResolvedValue(fakeIndex);
    vi.mocked(impactAnalysis).mockResolvedValue(makeFakeImpactResult());
    vi.mocked(computeCoChangePairs).mockReturnValue({
      pairs: [],
      total_commits: 10,
    });
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await testImpactAnalysis("test");

    expect(result.changed_files).toEqual(["src/tools/foo.ts"]);
    expect(result.affected_tests.length).toBeGreaterThanOrEqual(1);

    // Should have the test from impactAnalysis + naming match
    const fooTest = result.affected_tests.find(
      (t) => t.test_file === "tests/tools/foo.test.ts",
    );
    expect(fooTest).toBeDefined();
    // Has both call-graph reason AND naming match reason
    expect(fooTest!.reasons).toContain("imports foo (foo.ts)");
    expect(fooTest!.reasons.some((r) => r.startsWith("naming_match"))).toBe(true);
    // naming match gives 0.5 + 0.3 = 0.8
    expect(fooTest!.confidence).toBe(0.8);
  });

  it("includes vitest in suggested_command when vitest.config.ts exists", async () => {
    const fakeIndex = makeFakeIndex();
    vi.mocked(getCodeIndex).mockResolvedValue(fakeIndex);
    vi.mocked(impactAnalysis).mockResolvedValue(makeFakeImpactResult());
    vi.mocked(computeCoChangePairs).mockReturnValue({
      pairs: [],
      total_commits: 10,
    });
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes("vitest.config.ts");
    });

    const result = await testImpactAnalysis("test");

    expect(result.suggested_command).toContain("vitest");
  });

  it("throws when repo is not found", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);

    await expect(testImpactAnalysis("nonexistent")).rejects.toThrow(
      "Repository not found: nonexistent",
    );
  });
});
