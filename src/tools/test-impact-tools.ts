import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { impactAnalysis } from "./impact-tools.js";
import { computeCoChangePairs } from "./coupling-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestImpactResult {
  affected_tests: Array<{ test_file: string; confidence: number; reasons: string[] }>;
  suggested_command: string;
  changed_files: string[];
  /** How many tests matched before the cap — present only when the list was cut. */
  total_affected?: number;
}

/**
 * Ceiling on the returned test list.
 *
 * Nothing bounded it: telemetry over 33 calls shows a 3,150-token median against a **272,637-token
 * maximum** — by far the largest single response in the corpus, and past any context window.
 *
 * The cap also fixes the suggested command rather than only shortening it. That command inlines
 * every path (measured: 8,140 B for 207 tests at `since: HEAD~30`), so at a few thousand tests it
 * would exceed ARG_MAX and fail to run — a command that cannot be executed is not a suggestion.
 *
 * Safe to cut here because the list is already sorted by confidence descending, so the cap keeps
 * the tests most likely to matter and drops the weakest matches.
 */
const DEFAULT_MAX_AFFECTED_TESTS = 100;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute a confidence score for a test file based on naming convention match
 * and co-change jaccard similarity.
 */
export function computeTestConfidence(hasNamingMatch: boolean, jaccard: number): number {
  return Math.min(1.0, 0.5 + (hasNamingMatch ? 0.3 : 0) + Math.min(jaccard, 0.2));
}

/**
 * Given a production file path, find the corresponding test file using common
 * naming conventions:
 *   - src/tools/foo.ts → tests/tools/foo.test.ts
 *   - src/tools/foo.ts → src/tools/__tests__/foo.test.ts
 *   - src/tools/foo.ts → tests/tools/foo.spec.ts
 *
 * Returns the first match found in testFiles, or null.
 */
export function matchTestFile(prodFile: string, testFiles: string[]): string | null {
  // Extract dir and base: "src/tools/foo.ts" → dir="src/tools", base="foo", ext=".ts"
  const lastSlash = prodFile.lastIndexOf("/");
  const dir = lastSlash >= 0 ? prodFile.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? prodFile.slice(lastSlash + 1) : prodFile;
  const dotIdx = fileName.lastIndexOf(".");
  const base = dotIdx >= 0 ? fileName.slice(0, dotIdx) : fileName;
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx) : "";

  // Pattern 1: src → tests directory, .test extension
  const testsDir = dir.replace(/^src/, "tests");
  const candidate1 = testsDir ? `${testsDir}/${base}.test${ext}` : `${base}.test${ext}`;

  // Pattern 2: sibling __tests__ directory
  const candidate2 = dir ? `${dir}/__tests__/${base}.test${ext}` : `__tests__/${base}.test${ext}`;

  // Pattern 3: src → tests directory, .spec extension
  const candidate3 = testsDir ? `${testsDir}/${base}.spec${ext}` : `${base}.spec${ext}`;

  const testFileSet = new Set(testFiles);

  if (testFileSet.has(candidate1)) return candidate1;
  if (testFileSet.has(candidate2)) return candidate2;
  if (testFileSet.has(candidate3)) return candidate3;

  return null;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export async function testImpactAnalysis(
  repo: string,
  options?: { since?: string; until?: string; max_tests?: number },
): Promise<TestImpactResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const sinceRef = options?.since ?? "HEAD~1";

  // 1. Get impact analysis result (changed files + affected tests via call graph)
  const result = await impactAnalysis(repo, sinceRef);

  // 2. Collect all test files from the index
  const testFileList = index.files
    .map((f) => f.path)
    .filter((p) => isTestFile(p));

  // 3. Build affected test map: test_file → reasons[]
  const affectedMap = new Map<string, Set<string>>();

  const addAffected = (testFile: string, reason: string): void => {
    const existing = affectedMap.get(testFile);
    if (existing) {
      existing.add(reason);
    } else {
      affectedMap.set(testFile, new Set([reason]));
    }
  };

  // Add tests from impactAnalysis (call-graph based)
  for (const test of result.affected_tests) {
    addAffected(test.test_file, test.reason);
  }

  // Filter to only prod (non-test) changed files for naming match
  const changedProdFiles = result.changed_files.filter((f) => !isTestFile(f));

  // 4. Try naming convention matches for each changed prod file
  for (const prodFile of changedProdFiles) {
    const matched = matchTestFile(prodFile, testFileList);
    if (matched) {
      addAffected(matched, `naming_match (${prodFile})`);
    }
  }

  // 5. Get co-change pairs for jaccard scores
  let coChangePairs: Array<{ file_a: string; file_b: string; jaccard: number }> = [];
  try {
    const coChangeResult = await computeCoChangePairs(index.root, {
      since_days: 90,
      min_support: 2,
    });
    coChangePairs = coChangeResult.pairs;
  } catch {
    // Git history may not be available; continue without co-change data
  }

  // Build lookup: for each test file, find max jaccard against any changed prod file
  const jaccardByTest = new Map<string, number>();
  for (const pair of coChangePairs) {
    for (const testFile of affectedMap.keys()) {
      let maxJ = jaccardByTest.get(testFile) ?? 0;
      for (const prodFile of changedProdFiles) {
        if (
          (pair.file_a === testFile && pair.file_b === prodFile) ||
          (pair.file_b === testFile && pair.file_a === prodFile)
        ) {
          maxJ = Math.max(maxJ, pair.jaccard);
        }
      }
      if (maxJ > 0) {
        jaccardByTest.set(testFile, maxJ);
      }
    }
  }

  // 6. Compute confidence for each affected test
  const affectedTests: Array<{ test_file: string; confidence: number; reasons: string[] }> = [];
  for (const [testFile, reasons] of affectedMap) {
    const hasNamingMatch = [...reasons].some((r) => r.startsWith("naming_match"));
    const jaccard = jaccardByTest.get(testFile) ?? 0;
    const confidence = computeTestConfidence(hasNamingMatch, jaccard);

    affectedTests.push({
      test_file: testFile,
      confidence,
      reasons: [...reasons],
    });
  }

  // Sort by confidence descending
  affectedTests.sort((a, b) => b.confidence - a.confidence);

  const rawMax = options?.max_tests;
  const maxTests = typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
    ? Math.floor(rawMax)
    : DEFAULT_MAX_AFFECTED_TESTS;
  const totalAffected = affectedTests.length;
  const shownTests = totalAffected > maxTests ? affectedTests.slice(0, maxTests) : affectedTests;

  // Built from the SHOWN set, not the full one: a command naming tests the caller was not given is
  // both larger and less honest than one naming the tests it was.
  const suggested_command = buildSuggestedCommand(index.root, shownTests.map((t) => t.test_file));

  return {
    affected_tests: shownTests,
    suggested_command,
    changed_files: result.changed_files,
    ...(totalAffected > maxTests ? { total_affected: totalAffected } : {}),
  };
}

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

function buildSuggestedCommand(repoRoot: string, testPaths: string[]): string {
  const pathList = testPaths.join(" ");

  if (existsSync(join(repoRoot, "vitest.config.ts")) || existsSync(join(repoRoot, "vitest.config.js"))) {
    return `npx vitest run ${pathList}`;
  }
  if (existsSync(join(repoRoot, "jest.config.ts")) || existsSync(join(repoRoot, "jest.config.js"))) {
    return `npx jest ${pathList}`;
  }
  if (existsSync(join(repoRoot, "pytest.ini")) || existsSync(join(repoRoot, "pyproject.toml"))) {
    return `pytest ${pathList}`;
  }

  // Fallback
  return `npx vitest run ${pathList}`;
}
