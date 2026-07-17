import type { Dirent, Stats } from "node:fs";

export interface WalkOptions {
  includePaths?: string[] | undefined;
  maxFileSize?: number | undefined;
  maxFiles?: number | undefined;
  fileFilter?: ((ext: string, name?: string) => boolean) | undefined;
  relative?: boolean | undefined;
  followSymlinks?: boolean | undefined;
  excludePatterns?: string[] | undefined;
}

export interface ResolvedEntry {
  entry: Dirent;
  fullPath: string;
  isDirectory: boolean;
  isFile: boolean;
  stats?: Stats;
}
