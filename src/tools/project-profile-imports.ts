import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodeIndex } from "../types.js";

export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const sourceWithoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const patterns = [
    /^\s*import\s+(?:type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /^\s*export\s+(?:type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/gm,
    /^\s*export\s+\*\s+from\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /(?:^|[^\w"'])require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sourceWithoutComments))) {
      if (match[1]) specifiers.push(match[1]);
    }
  }

  return specifiers;
}

export function resolveRelativeImport(importerFile: string, specifier: string, indexedFiles: Set<string>): string | null {
  const basePaths: string[] = [];

  if (specifier.startsWith(".")) {
    const importerDir = importerFile.includes("/") ? importerFile.replace(/\/[^/]+$/, "") : "";
    basePaths.push(join(importerDir, specifier).replace(/\\/g, "/"));
  } else if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    const withoutAlias = specifier.slice(2);
    basePaths.push(`src/${withoutAlias}`, withoutAlias);
  } else {
    return null;
  }

  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  const candidates = basePaths.flatMap((base) => {
    const withoutExt = base.replace(/\.(ts|tsx|js|jsx)$/, "");
    return [
      base,
      ...extensions.map((extension) => `${withoutExt}${extension}`),
      ...extensions.map((extension) => `${withoutExt}/index${extension}`),
    ];
  });

  return candidates.find((candidate) => indexedFiles.has(candidate)) ?? null;
}

function collectImports(
  importerFile: string,
  source: string,
  indexedFiles: Set<string>,
  importersByFile: Map<string, Set<string>>,
): void {
  for (const specifier of extractImportSpecifiers(source)) {
    const importedFile = resolveRelativeImport(importerFile, specifier, indexedFiles);
    if (!importedFile || importedFile === importerFile) continue;

    const importers = importersByFile.get(importedFile) ?? new Set<string>();
    importers.add(importerFile);
    importersByFile.set(importedFile, importers);
  }
}

function toImporterCount(importersByFile: Map<string, Set<string>>): Map<string, number> {
  return new Map([...importersByFile.entries()].map(([file, importers]) => [file, importers.size]));
}

export function buildImporterCountFromSources(index: CodeIndex): Map<string, number> {
  const indexedFiles = new Set(index.files.map((file) => file.path));
  const importersByFile = new Map<string, Set<string>>();

  for (const symbol of index.symbols) {
    if (!symbol.source) continue;
    collectImports(symbol.file, symbol.source, indexedFiles, importersByFile);
  }

  return toImporterCount(importersByFile);
}

export async function buildImporterCount(index: CodeIndex): Promise<Map<string, number>> {
  const indexedFiles = new Set(index.files.map((file) => file.path));
  const importersByFile = new Map<string, Set<string>>();
  const filesWithSource = new Set<string>();

  for (const file of index.files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file.path) || /\.d\.ts$/.test(file.path)) continue;

    try {
      const source = await readFile(join(index.root, file.path), "utf-8");
      filesWithSource.add(file.path);
      collectImports(file.path, source, indexedFiles, importersByFile);
    } catch {
      // Synthetic indexes in tests and partial indexes may only have symbol source.
    }
  }

  for (const symbol of index.symbols) {
    if (!symbol.source || filesWithSource.has(symbol.file)) continue;
    collectImports(symbol.file, symbol.source, indexedFiles, importersByFile);
  }

  return toImporterCount(importersByFile);
}
