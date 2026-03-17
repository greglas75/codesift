/**
 * Glob-matching utilities shared by outline-tools and search-tools.
 *
 * Uses picomatch for proper glob support including braces ({ts,tsx}),
 * character classes, extglobs, and ** path matching.
 */
import picomatch from "picomatch";

/** Cache compiled matchers — patterns repeat heavily across file lists */
const matcherCache = new Map<string, picomatch.Matcher>();

function getMatcher(pattern: string, options?: picomatch.PicomatchOptions): picomatch.Matcher {
  const key = `${pattern}\0${options?.matchBase ? "b" : ""}${options?.contains ? "c" : ""}`;
  let matcher = matcherCache.get(key);
  if (!matcher) {
    matcher = picomatch(pattern, options);
    matcherCache.set(key, matcher);
  }
  return matcher;
}

/**
 * Returns true if the pattern contains glob special characters.
 * Plain strings like "foo.ts" or "service" are treated as substring matches.
 */
function hasGlobChars(pattern: string): boolean {
  return /[*?{[!@+(]/.test(pattern);
}

/**
 * Match a file path against a glob pattern.
 *
 * Supports all standard glob features:
 *   "*.ts", "*.{ts,tsx}", "src/*.ts", "src/**\/*.ts", "**\/*.test.ts",
 *   "src/**", "[!.]*.ts", and plain substring matching for non-glob strings.
 *
 * Pattern is matched against the full relative path.
 * Basename-only patterns (no "/") use matchBase for deep matching.
 */
export function matchFilePattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;

  // Non-glob strings: substring match (preserves existing behavior for "service", "foo.ts", etc.)
  if (!hasGlobChars(pattern)) {
    return filePath.includes(pattern);
  }

  // Basename-only glob (e.g. "*.ts", "*.{ts,tsx}", "*risk*.test.*")
  // → matchBase makes it match against the filename portion at any depth
  if (!pattern.includes("/")) {
    return getMatcher(pattern, { matchBase: true })(filePath);
  }

  // Full path glob (e.g. "src/**/*.ts", "src/*.ts", "**/utils/*.ts")
  return getMatcher(pattern)(filePath);
}

/**
 * Match a filename (or path) against a glob pattern.
 *
 * Pattern is matched against the filename portion only (not the full path),
 * unless it contains "/" or starts with "**\/".
 */
export function matchNamePattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;

  // Path-style patterns match against full path
  if (pattern.includes("/")) {
    return getMatcher(pattern)(filePath);
  }

  const fileName = filePath.includes("/")
    ? filePath.slice(filePath.lastIndexOf("/") + 1)
    : filePath;

  // Non-glob: exact filename or substring of path
  if (!hasGlobChars(pattern)) {
    return fileName === pattern || filePath.includes(pattern);
  }

  // Glob against filename only
  return getMatcher(pattern)(fileName);
}