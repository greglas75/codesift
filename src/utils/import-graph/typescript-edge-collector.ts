import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getCachedParse, setCachedParse } from "../../parser/parse-cache.js";
import { getParser } from "../../parser/parser-manager.js";
import type { CodeIndex } from "../../types.js";
import { extractTypeScriptImports } from "../ts-imports.js";
import { resolveTsAliasedImport } from "../tsconfig-paths.js";
import { resolveImportPath } from "./path-map.js";
import type { AddImportEdge } from "./types.js";

export interface TsCollectionOutcome {
  astHandled: boolean;
  skipFile: boolean;
}

function resolveRelativeImport(
  importerFile: string,
  importPath: string,
  normalizedPaths: Map<string, string>,
): string | null {
  let normalized = resolveImportPath(importerFile, importPath);
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalizedPaths.get(normalized) ?? null;
}

function resolveAliasedImport(
  index: CodeIndex,
  importerFile: string,
  importPath: string,
  normalizedPaths: Map<string, string>,
): string | null {
  const aliased = resolveTsAliasedImport(join(index.root, importerFile), importPath, index.root);
  if (!aliased) return null;
  const relativePath = relative(resolve(index.root), resolve(aliased));
  const insideRoot = relativePath !== "" && !isAbsolute(relativePath) && !relativePath.startsWith("..");
  if (!insideRoot) return null;
  const normalizedRelativePath = relativePath.split(sep).join("/");
  const indexed = normalizedPaths.has(normalizedRelativePath.replace(/\.[^./]+$/, "")) ||
    index.files.some((file) => file.path === normalizedRelativePath);
  return indexed ? normalizedRelativePath : null;
}

export async function collectTypeScriptEdges(
  index: CodeIndex,
  filePath: string,
  source: string,
  normalizedPaths: Map<string, string>,
  addEdge: AddImportEdge,
): Promise<TsCollectionOutcome> {
  if (!/\.tsx?$/.test(filePath)) return { astHandled: false, skipFile: false };
  try {
    const language = filePath.endsWith(".tsx") ? "tsx" : "typescript";
    const parser = await getParser(language);
    if (!parser) return { astHandled: false, skipFile: false };
    let tree = getCachedParse(language, source);
    if (!tree) {
      tree = parser.parse(source);
      if (!tree) return { astHandled: false, skipFile: true };
      setCachedParse(language, source, tree);
    }
    for (const imported of extractTypeScriptImports(tree)) {
      const resolved = imported.path.startsWith(".")
        ? resolveRelativeImport(filePath, imported.path, normalizedPaths)
        : resolveAliasedImport(index, filePath, imported.path, normalizedPaths);
      if (resolved) addEdge(filePath, resolved, { type_only: imported.is_type_only });
    }
    return { astHandled: true, skipFile: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[import-graph] TS AST extraction failed for ${filePath}; falling back to regex: ${message}`);
    return { astHandled: false, skipFile: false };
  }
}
