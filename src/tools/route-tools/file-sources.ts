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
    } catch (err: unknown) {
      // Every read failure became "file absent", so a permission or I/O error looked exactly like
      // a project with no routes. ENOENT is genuinely unremarkable — the index can outlive a file.
      // Anything else is an operational problem the caller has no other way to learn about.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `[codesift] route source unreadable: ${file.path} — `
          + `${err instanceof Error ? err.message : String(err)}. Routes in it will be missing.`,
        );
      }
      return null;
    }
  }));
  return sources.filter((source): source is IndexedFileSource => source !== null);
}
