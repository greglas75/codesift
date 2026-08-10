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
  const parts = importerDir === "." ? [] : importerDir.split("/");

  const importSegments = importPath.split("/");
  for (const segment of importSegments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return "";
      parts.pop();
    }
    else parts.push(segment);
  }

  if (parts.length === 0 && importSegments.every((segment) => segment === "." || segment === "")) {
    return ".";
  }
  return parts.join("/").replace(RELATIVE_IMPORT_EXTENSION, "");
}

/** Build normalized path map for matching imports to indexed files. */
export function buildNormalizedPathMap(index: CodeIndex): Map<string, string> {
  const normalizedPaths = new Map<string, string>();
  const ambiguousPaths = new Set<string>();

  const addPath = (key: string, filePath: string): void => {
    if (ambiguousPaths.has(key)) return;
    const existing = normalizedPaths.get(key);
    if (existing && existing !== filePath) {
      normalizedPaths.delete(key);
      ambiguousPaths.add(key);
      return;
    }
    normalizedPaths.set(key, filePath);
  };

  for (const file of index.files) {
    const normalized = stripIndexedSourceExtension(file.path);
    addPath(normalized, file.path);
    if (normalized.endsWith("/index")) {
      addPath(normalized.slice(0, -6), file.path);
    }
    if (normalized.endsWith("/__init__")) {
      addPath(normalized.slice(0, -9), file.path);
    }
  }
  return normalizedPaths;
}
