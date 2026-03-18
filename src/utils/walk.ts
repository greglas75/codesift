import { readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

/**
 * Directories to skip during filesystem walks.
 * Shared by index-tools, search-tools, and (via toIgnorePatterns) watcher.
 */
export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".codesift", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".tox", ".mypy_cache", ".turbo",
  "generated", "audit-results", ".backup", "jscpd-report",
  "helpscout_export", ".output",
]);

/**
 * Convert IGNORE_DIRS to chokidar-compatible glob patterns.
 * e.g., "node_modules" -> "**\/node_modules/**"
 */
export function toIgnorePatterns(): string[] {
  return [...IGNORE_DIRS].map((dir) => `**/${dir}/**`);
}

const DEFAULT_MAX_FILE_SIZE = 1_000_000; // 1MB

export interface WalkOptions {
  /**
   * When provided, only files whose relative path starts with one of these
   * prefixes are included.
   */
  includePaths?: string[] | undefined;

  /**
   * Maximum file size in bytes. Files larger than this are skipped.
   * Defaults to 1 MB.
   */
  maxFileSize?: number | undefined;

  /**
   * Safety cap on the number of files returned. When reached, walking stops
   * and a warning is printed. Defaults to unlimited.
   */
  maxFiles?: number | undefined;

  /**
   * Called for each file entry. Return `true` to include the file, `false` to
   * skip it. Receives the file's extension (including the dot, e.g. ".ts").
   *
   * When omitted every file (within size limits) is included.
   */
  fileFilter?: ((ext: string) => boolean) | undefined;

  /**
   * When `true` the returned paths are relative to `rootPath`.
   * When `false` (default) the returned paths are absolute.
   */
  relative?: boolean | undefined;
}

/**
 * Walk a directory tree collecting files.
 * Skips directories listed in IGNORE_DIRS and hidden directories (dot-prefixed).
 */
export async function walkDirectory(
  rootPath: string,
  options?: WalkOptions,
): Promise<string[]> {
  const files: string[] = [];
  const maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options?.maxFiles ?? Infinity;
  const fileFilter = options?.fileFilter;
  const includePaths = options?.includePaths;
  const useRelative = options?.relative ?? false;
  let limitReached = false;

  async function walk(dirPath: string): Promise<void> {
    if (limitReached) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    for (const entry of entries) {
      if (limitReached) return;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);

        // Apply caller's file filter (e.g. language check, binary exclusion)
        if (fileFilter && !fileFilter(ext)) continue;

        // Filter by include paths if specified
        if (includePaths && includePaths.length > 0) {
          const relPath = relative(rootPath, fullPath);
          const matches = includePaths.some((p) => relPath.startsWith(p));
          if (!matches) continue;
        }

        // Skip files that are too large
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > maxFileSize) continue;
        } catch {
          continue;
        }

        files.push(useRelative ? relative(rootPath, fullPath) : fullPath);

        if (files.length >= maxFiles) {
          console.warn(
            `[codesift] walkDirectory: reached ${maxFiles} file limit, returning partial results`,
          );
          limitReached = true;
          return;
        }
      }
    }
  }

  await walk(rootPath);
  return files;
}
