import { join } from "node:path";
import type { Dirent } from "node:fs";
import { readDirectory, readStats } from "./errors.js";
import type { ResolvedEntry } from "./types.js";

interface TraversalOptions {
  followSymlinks: boolean;
  shouldSkipDirectory(name: string): boolean;
  onFile(entry: ResolvedEntry): Promise<boolean>;
}

export async function traverseDirectory(
  rootPath: string,
  options: TraversalOptions,
): Promise<void> {
  const visitedInodes = new Set<number>();

  async function visit(dirPath: string): Promise<boolean> {
    const entries = await readDirectory(dirPath);
    for (const entry of entries) {
      const resolved = await resolveEntry(dirPath, entry, options.followSymlinks, visitedInodes);
      if (!resolved) continue;

      if (resolved.isDirectory) {
        if (options.shouldSkipDirectory(entry.name)) continue;
        if (!(await visit(resolved.fullPath))) return false;
      } else if (resolved.isFile && !(await options.onFile(resolved))) {
        return false;
      }
    }
    return true;
  }

  await visit(rootPath);
}

async function resolveEntry(
  dirPath: string,
  entry: Dirent,
  followSymlinks: boolean,
  visitedInodes: Set<number>,
): Promise<ResolvedEntry | null> {
  const fullPath = join(dirPath, entry.name);
  if (!entry.isSymbolicLink()) {
    return { entry, fullPath, isDirectory: entry.isDirectory(), isFile: entry.isFile() };
  }
  if (!followSymlinks) return null;

  const stats = await readStats(fullPath);
  if (!stats || visitedInodes.has(stats.ino)) return null;
  visitedInodes.add(stats.ino);
  return { entry, fullPath, isDirectory: stats.isDirectory(), isFile: stats.isFile(), stats };
}
