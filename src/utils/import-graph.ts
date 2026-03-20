/**
 * Import graph utilities — shared by context-tools, route-tools, community-tools.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeIndex } from "../types.js";

export interface ImportEdge {
  from: string; // importer file path
  to: string;   // imported file path
}

// Patterns for detecting import statements across common languages
const IMPORT_PATTERNS = [
  // ES modules: import ... from '...' or import ... from "..."
  /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
  // Dynamic import: import('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS: require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Extract import paths from a source string.
 * Returns relative paths only (skips node_modules / bare specifiers).
 */
export function extractImports(source: string): string[] {
  const imports = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const importPath = match[1];
      if (importPath && importPath.startsWith(".")) {
        imports.add(importPath);
      }
    }
  }

  return [...imports];
}

/**
 * Normalize an import path relative to the importing file.
 * Resolves "./foo" and "../bar" relative to the importer's directory.
 */
export function resolveImportPath(importerFile: string, importPath: string): string {
  const importerDir = importerFile.includes("/")
    ? importerFile.slice(0, importerFile.lastIndexOf("/"))
    : ".";

  const parts = importerDir.split("/");

  for (const segment of importPath.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  let resolved = parts.join("/");
  resolved = resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

  return resolved;
}

/**
 * Build normalized path map for matching imports to indexed files.
 */
export function buildNormalizedPathMap(index: CodeIndex): Map<string, string> {
  const normalizedPaths = new Map<string, string>();
  for (const file of index.files) {
    const normalized = file.path.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    normalizedPaths.set(normalized, file.path);
    if (normalized.endsWith("/index")) {
      normalizedPaths.set(normalized.slice(0, -6), file.path);
    }
  }
  return normalizedPaths;
}

/**
 * Collect all import edges between files in the index.
 * Reads file source from disk to extract import statements.
 */
export async function collectImportEdges(
  index: CodeIndex,
  fileFilter?: Set<string>,
): Promise<ImportEdge[]> {
  const normalizedPaths = buildNormalizedPathMap(index);
  const edgeSet = new Set<string>();
  const edges: ImportEdge[] = [];

  const files = fileFilter
    ? index.files.filter((f) => fileFilter.has(f.path))
    : index.files;

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }

    const importPaths = extractImports(source);
    for (const importPath of importPaths) {
      const resolved = resolveImportPath(file.path, importPath);
      const targetFile = normalizedPaths.get(resolved);
      if (!targetFile || targetFile === file.path) continue;

      const edgeKey = `${file.path}->${targetFile}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      edges.push({ from: file.path, to: targetFile });
    }
  }

  return edges;
}

/**
 * Build adjacency lists (bidirectional) from import edges.
 */
export function buildImportAdjacency(edges: ImportEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    let fromSet = adj.get(edge.from);
    if (!fromSet) { fromSet = new Set(); adj.set(edge.from, fromSet); }
    fromSet.add(edge.to);

    let toSet = adj.get(edge.to);
    if (!toSet) { toSet = new Set(); adj.set(edge.to, toSet); }
    toSet.add(edge.from);
  }
  return adj;
}
