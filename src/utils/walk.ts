import { relative } from "node:path";
import { createFileFilter, IGNORE_DIRS, toIgnorePatterns, BACKUP_FILE_PATTERNS } from "./walk/filters.js";
import { WalkLimits } from "./walk/limits.js";
import { readStats } from "./walk/errors.js";
import { traverseDirectory } from "./walk/traversal.js";
import type { WalkOptions } from "./walk/types.js";

export { BACKUP_FILE_PATTERNS, IGNORE_DIRS, toIgnorePatterns };
export type { WalkOptions } from "./walk/types.js";

export async function walkDirectory(
  rootPath: string,
  options?: WalkOptions,
): Promise<string[]> {
  const normalizedOptions = options ?? {};
  const files: string[] = [];
  const limits = new WalkLimits(normalizedOptions.maxFileSize, normalizedOptions.maxFiles);
  const filters = createFileFilter(rootPath, normalizedOptions);

  await traverseDirectory(rootPath, {
    followSymlinks: normalizedOptions.followSymlinks ?? false,
    shouldSkipDirectory: filters.shouldSkipDirectory,
    onFile: async ({ fullPath, entry, stats }) => {
      if (!filters.shouldIncludeFile(fullPath, entry.name)) return true;
      const fileStats = stats ?? (await readStats(fullPath));
      if (!fileStats || fileStats.size > limits.maxFileSize) return true;

      files.push(normalizedOptions.relative ? relative(rootPath, fullPath) : fullPath);
      limits.acceptFile();
      return limits.canContinue;
    },
  });

  return files;
}
