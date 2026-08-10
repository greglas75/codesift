import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeIndex } from "../../types.js";

export interface IndexedFileSource {
  path: string;
  source: string;
}

export async function readIndexedFiles(
  index: CodeIndex,
  matches: (path: string) => boolean,
): Promise<IndexedFileSource[]> {
  const candidates = index.files.filter((file) => matches(file.path));
  const sources = await Promise.all(candidates.map(async (file) => {
    try {
      return { path: file.path, source: await readFile(join(index.root, file.path), "utf-8") };
    } catch {
      return null;
    }
  }));
  return sources.filter((source): source is IndexedFileSource => source !== null);
}
