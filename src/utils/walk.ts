import { readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import picomatch from "picomatch";

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

/**
 * Backup and editor-generated files to exclude by default.
 * These patterns commonly appear in working directories and cause:
 * - Index duplication (e.g. Mobi2 had Survey.php + Survey copy.php)
 * - False references pointing at backup files
 * - Wasted parser time on abandoned code
 *
 * Disabled with env var CODESIFT_INCLUDE_BACKUPS=1.
 */
export const BACKUP_FILE_PATTERNS: RegExp[] = [
  /copy\.php$/i,       // macOS Finder "Duplicate" output
  /\.bak$/i,           // generic backup
  /\.orig$/i,          // merge conflict leftover
  /~$/,                // emacs/joe backup
  /\.swp$/i,           // vim swap
  /\.swo$/i,           // vim swap
  /\.DS_Store$/,       // macOS finder metadata
];

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
  fileFilter?: ((ext: string, name?: string) => boolean) | undefined;

  /**
   * When `true` the returned paths are relative to `rootPath`.
   * When `false` (default) the returned paths are absolute.
   */
  relative?: boolean | undefined;

  /**
   * When `true`, follow symlinks and walk their targets.
   * Cycle detection via inode tracking prevents infinite loops.
   * Defaults to `false`.
   */
  followSymlinks?: boolean | undefined;

  /**
   * Glob patterns to exclude (like .gitignore syntax).
   * Matched against relative paths using picomatch.
   * Example: ["dist/**", "*.generated.ts"]
   */
  excludePatterns?: string[] | undefined;
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
  const followSymlinks = options?.followSymlinks ?? false;
  const visitedInodes = new Set<number>();
  let limitReached = false;

  // Compile exclude patterns once (picomatch)
  let isExcluded: ((path: string) => boolean) | null = null;
  if (options?.excludePatterns && options.excludePatterns.length > 0) {
    try {
      isExcluded = picomatch(options.excludePatterns, { dot: true });
    } catch {
      // Malformed patterns — warn and skip filtering
      console.warn("[codesift] walkDirectory: invalid excludePatterns, ignoring");
    }
  }

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

      const isSymlink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      // Resolve symlinks when followSymlinks is enabled
      if (isSymlink && followSymlinks) {
        try {
          const resolved = await stat(fullPath);
          const ino = resolved.ino;
          if (visitedInodes.has(ino)) {
            // Cycle detected — skip
            continue;
          }
          visitedInodes.add(ino);
          isDir = resolved.isDirectory();
          isFile = resolved.isFile();
        } catch {
          // Broken symlink — skip silently
          continue;
        }
      } else if (isSymlink) {
        // Not following symlinks — skip
        continue;
      }

      if (isDir) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (isFile) {
        const ext = extname(entry.name);

        // Exclude backup / editor-generated files unless env var opts out.
        // Checked before file filter so the noise never reaches the caller.
        if (process.env.CODESIFT_INCLUDE_BACKUPS !== "1" &&
            BACKUP_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;

        // Apply caller's file filter (e.g. language check, binary exclusion)
        if (fileFilter && !fileFilter(ext, entry.name)) continue;

        // Filter by include paths if specified
        if (includePaths && includePaths.length > 0) {
          const relPath = relative(rootPath, fullPath);
          const matches = includePaths.some((p) => relPath.startsWith(p));
          if (!matches) continue;
        }

        // Apply exclude patterns
        if (isExcluded) {
          const relPath = relative(rootPath, fullPath);
          if (isExcluded(relPath)) continue;
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
