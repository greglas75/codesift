import path from "node:path";
import { isTestFile } from "../../../utils/test-file.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?)$/;

/**
 * Test-gaps check: for each changed non-test source file, verify that at least
 * one test file covers it — either by naming convention or by import reference.
 *
 * Naming convention candidates:
 *   foo.ts -> foo.test.ts, foo.spec.ts, __tests__/foo.ts, __tests__/foo.test.ts
 *
 * Import graph: search index symbols from test files whose source imports the
 * source file's base name (without extension).
 *
 * If BOTH pathways find 0 tests -> T3 advisory finding.
 */
export async function checkTestGaps(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  const indexFilePaths = new Set(index.files.map((f) => f.path));
  const findings: ReviewFinding[] = [];

  for (const sourceFile of sourceFilesFromDiff(changedFiles)) {
    if (hasTestCoverage(index, indexFilePaths, sourceFile)) continue;
    findings.push({
      check: "test-gaps",
      severity: "warn",
      message: `No test found for "${sourceFile}" — add a test file matching naming convention or import it from a test`,
      file: sourceFile,
    });
  }

  return {
    check: "test-gaps",
    status: findings.length > 0 ? "warn" : "pass",
    findings,
    duration_ms: Date.now() - start,
    summary: findings.length > 0
      ? `${findings.length} source file(s) with no test coverage found`
      : "All changed source files have test coverage",
  };
}

function sourceFilesFromDiff(changedFiles: string[]): string[] {
  return changedFiles.filter(
    (f) => SOURCE_EXTENSIONS.test(f) && !isTestFile(f),
  );
}

function hasTestCoverage(
  index: CodeIndex,
  indexFilePaths: Set<string>,
  sourceFile: string,
): boolean {
  const base = path.basename(sourceFile).replace(SOURCE_EXTENSIONS, "");
  return hasTestByNaming(indexFilePaths, sourceFile, base) || hasTestByImport(index, base);
}

function hasTestByNaming(
  indexFilePaths: Set<string>,
  sourceFile: string,
  base: string,
): boolean {
  return testCandidates(sourceFile, base).some((candidate) =>
    indexFilePaths.has(candidate),
  );
}

function testCandidates(sourceFile: string, base: string): string[] {
  const dir = path.dirname(sourceFile);
  const testsDir = dir.replace(/^src\//, "tests/");
  return [
    path.join(dir, `${base}.test.ts`),
    path.join(dir, `${base}.spec.ts`),
    path.join(dir, `${base}.test.tsx`),
    path.join(dir, `${base}.spec.tsx`),
    path.join(dir, `${base}.test.js`),
    path.join(dir, `${base}.spec.js`),
    path.join(dir, "__tests__", `${base}.ts`),
    path.join(dir, "__tests__", `${base}.test.ts`),
    path.join(testsDir, `${base}.test.ts`),
    path.join(testsDir, `${base}.spec.ts`),
    path.join(testsDir, `${base}.test.tsx`),
    path.join(testsDir, `${base}.test.js`),
  ];
}

function hasTestByImport(index: CodeIndex, base: string): boolean {
  return index.symbols.some((sym) => {
    if (!isTestFile(sym.file)) return false;
    if (!sym.source) return false;
    return sym.source.includes(base);
  });
}
