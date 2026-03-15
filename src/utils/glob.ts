/**
 * Glob-matching utilities shared by outline-tools and search-tools.
 */

/**
 * Simple glob matching: splits pattern on "*" and checks that the segments
 * appear in order within the text. Handles multiple wildcards correctly.
 *
 * Examples: "*.ts" matches "foo.ts", "*risk*.test.*" matches "risk-audit.service.test.ts"
 */
export function globMatch(text: string, pattern: string): boolean {
  const parts = pattern.split("*");

  // First part must be a prefix (or empty if pattern starts with *)
  const first = parts[0];
  if (first !== undefined && first !== "" && !text.startsWith(first)) return false;

  // Last part must be a suffix (or empty if pattern ends with *)
  const last = parts[parts.length - 1];
  if (last !== undefined && last !== "" && !text.endsWith(last)) return false;

  // All parts must appear in order
  let pos = 0;
  for (const part of parts) {
    if (part === "") continue;
    const idx = text.indexOf(part, pos);
    if (idx < 0) return false;
    pos = idx + part.length;
  }

  return true;
}

/**
 * Match a file path against a simple glob pattern.
 * Supports: "*.ts", "src/*.ts", "src/**\/*.ts", "**\/*.test.ts",
 *           "src/**", and plain substring matching.
 *
 * Pattern is matched against the full relative path.
 */
export function matchFilePattern(filePath: string, pattern: string): boolean {
  // Exact match
  if (filePath === pattern) return true;

  // "**/" prefix — match anywhere in path
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return matchFilePattern(filePath, suffix) ||
      filePath.includes("/" + suffix) ||
      matchFileSuffix(filePath, suffix);
  }

  // "*" at the start — match extension-style patterns like "*.ts"
  if (pattern.startsWith("*") && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return filePath.endsWith(suffix);
  }

  // "dir/**" — match everything under directory (e.g., "src/**")
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }

  // Pattern with "**" in the middle (e.g., "src/**/*.ts")
  if (pattern.includes("/**/")) {
    const [prefix, suffix] = splitFirst(pattern, "/**/");
    if (!filePath.startsWith(prefix + "/") && filePath !== prefix) return false;
    const rest = filePath.slice(prefix.length + 1);
    return matchFilePattern(rest, suffix) ||
      matchFilePattern(rest, "**/" + suffix);
  }

  // Simple directory prefix + filename pattern (e.g., "src/*.ts")
  if (pattern.includes("/") && pattern.includes("*")) {
    const lastSlash = pattern.lastIndexOf("/");
    const dirPart = pattern.slice(0, lastSlash);
    const filePart = pattern.slice(lastSlash + 1);
    const fileLastSlash = filePath.lastIndexOf("/");
    const fileDir = fileLastSlash >= 0 ? filePath.slice(0, fileLastSlash) : "";
    const fileName = fileLastSlash >= 0 ? filePath.slice(fileLastSlash + 1) : filePath;

    if (fileDir !== dirPart) return false;
    return matchFilePattern(fileName, filePart);
  }

  // No wildcards: substring match on the full path
  if (!pattern.includes("*")) {
    return filePath.includes(pattern);
  }

  return false;
}

/**
 * Match a filename (or path) against a glob pattern.
 * Supports: "*.ts", "route.ts", "*risk*.test.*", "**\/*.ts"
 *
 * Pattern is matched against the filename portion only (not the full path),
 * unless it contains "/" or starts with "**\/".
 */
export function matchNamePattern(filePath: string, pattern: string): boolean {
  // Handle **/ prefix: match anywhere in path
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return matchNamePattern(filePath, suffix) ||
      filePath.includes("/" + suffix);
  }

  // If pattern contains "/" it's a path pattern — match against full path
  if (pattern.includes("/")) {
    return globMatch(filePath, pattern);
  }

  // Otherwise match against filename only
  const fileName = filePath.includes("/")
    ? filePath.slice(filePath.lastIndexOf("/") + 1)
    : filePath;

  // No wildcard: exact filename match or substring of path
  if (!pattern.includes("*")) {
    return fileName === pattern || filePath.includes(pattern);
  }

  return globMatch(fileName, pattern);
}

function matchFileSuffix(filePath: string, suffix: string): boolean {
  if (suffix.startsWith("*")) {
    const ext = suffix.slice(1);
    return filePath.endsWith(ext);
  }
  return filePath.endsWith("/" + suffix) || filePath === suffix;
}

function splitFirst(str: string, sep: string): [string, string] {
  const idx = str.indexOf(sep);
  if (idx < 0) return [str, ""];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}
