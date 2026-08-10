import type { CodeIndex } from "../../types.js";

const RELATIVE_IMPORT_EXTENSION = /\.(astro|ts|tsx|js|jsx|mjs|cjs|php)$/;
const INDEXED_SOURCE_EXTENSION = /\.(astro|ts|tsx|js|jsx|mjs|cjs|php|kt|kts|py)$/;

export function stripIndexedSourceExtension(filePath: string): string {
  return filePath.replace(INDEXED_SOURCE_EXTENSION, "");
}

/** Normalize an import path relative to the importing file. */
export function resolveImportPath(importerFile: string, importPath: string): string {
  const importerDir = importerFile.includes("/")
    ? importerFile.slice(0, importerFile.lastIndexOf("/"))
    : ".";
  const parts = importerDir.split("/");

  for (const segment of importPath.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }

  return parts.join("/").replace(RELATIVE_IMPORT_EXTENSION, "");
}

/** Build normalized path map for matching imports to indexed files. */
export function buildNormalizedPathMap(index: CodeIndex): Map<string, string> {
  const normalizedPaths = new Map<string, string>();
  for (const file of index.files) {
    const normalized = stripIndexedSourceExtension(file.path);
    normalizedPaths.set(normalized, file.path);
    if (normalized.endsWith("/index")) {
      normalizedPaths.set(normalized.slice(0, -6), file.path);
    }
    if (normalized.endsWith("/__init__")) {
      normalizedPaths.set(normalized.slice(0, -9), file.path);
    }
  }
  return normalizedPaths;
}
