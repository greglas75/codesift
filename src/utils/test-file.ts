/** Test file patterns — shared between BM25 scoring and call graph filtering */
const TEST_FILE_PATTERNS = [
  ".test.", ".spec.", "__tests__/", "test/mocks", "test-utils", "test-helpers",
];

/** Regex-based test file patterns for stricter matching (e.g., call graph filtering) */
const TEST_FILE_REGEX_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\/__tests__\//,
  /\/test\//,
  /\/tests\//,
];

/**
 * Check if a file path looks like a test file using substring matching.
 * Used by BM25 scoring to demote test files.
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => filePath.includes(pattern));
}

/**
 * Check if a file path looks like a test file using regex patterns.
 * Stricter than isTestFile — used by call graph to exclude test files.
 */
export function isTestFileStrict(filePath: string): boolean {
  return TEST_FILE_REGEX_PATTERNS.some((p) => p.test(filePath));
}
