import { extname, relative } from "node:path";
import picomatch from "picomatch";
import type { WalkOptions } from "./types.js";

export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".codesift", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".tox", ".mypy_cache", ".turbo",
  "generated", "audit-results", ".backup", "jscpd-report",
  "helpscout_export", ".output", ".pnpm",
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
