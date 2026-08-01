import { extname, relative } from "node:path";
import picomatch from "picomatch";
import type { WalkOptions } from "./types.js";

const ALWAYS_IGNORED = [
  "node_modules", ".git", "dist", "build", "coverage",
  ".codesift", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".tox", ".mypy_cache", ".turbo",
  "generated", "audit-results", ".backup", "jscpd-report",
  "helpscout_export", ".output", ".pnpm",
];

/**
 * Third-party code that is `node_modules` under a different name — Composer,
 * Go, Ruby and Rust all install into `vendor/`.
 *
 * Measured on real indexes before this was excluded: `tgm-mobi` 44,534 of
 * 50,006 files (89%, 377 MB), `Mobi3` 89%, `tgm-collect` 10,083 of 11,622
 * (87%). Two of those sat exactly on the 50,000-file indexing cap, which means
 * dependency code was not merely slowing things down — it was pushing the
 * project's own source OUT of the index, silently. Graph tools then walked the
 * whole vendored tree and hit the 90s tool timeout, so they were unusable on
 * every PHP project.
 *
 * Escape hatch for the rare repo whose `vendor/` really is first-party source:
 * `CODESIFT_INDEX_VENDOR=1`. Read once at module load, like the other walk
 * toggles.
 */
const VENDOR_DIRS = ["vendor"];

export const IGNORE_DIRS = new Set([
  ...ALWAYS_IGNORED,
  ...(process.env["CODESIFT_INDEX_VENDOR"] === "1" ? [] : VENDOR_DIRS),
]);

export function toIgnorePatterns(): string[] {
  return [...IGNORE_DIRS].map((dir) => `**/${dir}/**`);
}

export const BACKUP_FILE_PATTERNS: RegExp[] = [
  /copy\.php$/i,
  /\.bak$/i,
  /\.orig$/i,
  /~$/,
  /\.swp$/i,
  /\.swo$/i,
  /\.DS_Store$/,
];

interface FileFilter {
  shouldSkipDirectory(name: string): boolean;
  shouldIncludeFile(fullPath: string, name: string): boolean;
}

export function createFileFilter(rootPath: string, options: WalkOptions): FileFilter {
  let isExcluded: ((path: string) => boolean) | null = null;
  if (options.excludePatterns && options.excludePatterns.length > 0) {
    try {
      isExcluded = picomatch(options.excludePatterns, { dot: true });
    } catch {
      console.warn("[codesift] walkDirectory: invalid excludePatterns, ignoring");
    }
  }

  return {
    shouldSkipDirectory(name: string): boolean {
      return IGNORE_DIRS.has(name) || name.startsWith(".");
    },
    shouldIncludeFile(fullPath: string, name: string): boolean {
      if (process.env.CODESIFT_INCLUDE_BACKUPS !== "1" &&
          BACKUP_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
        return false;
      }

      const ext = extname(name);
      if (options.fileFilter && !options.fileFilter(ext, name)) return false;

      const relPath = relative(rootPath, fullPath);
      if (options.includePaths && options.includePaths.length > 0 &&
          !options.includePaths.some((prefix) => relPath.startsWith(prefix))) {
        return false;
      }
      return !isExcluded || !isExcluded(relPath);
    },
  };
}
