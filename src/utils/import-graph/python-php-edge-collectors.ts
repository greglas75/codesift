import { getCachedParse, setCachedParse } from "../../parser/parse-cache.js";
import { getParser } from "../../parser/parser-manager.js";
import { resolvePhpNamespace } from "../../tools/php-tools.js";
import type { CodeIndex } from "../../types.js";
import { extractPythonImports, extractPythonImportsByRegex } from "../python-imports.js";
import { resolvePythonImport } from "../python-import-resolver.js";
import { extractPhpUseStatements } from "./language-imports.js";
import type { AddImportEdge, PythonImportContext } from "./types.js";

export async function collectPhpEdges(
  index: CodeIndex,
  filePath: string,
  source: string,
  normalizedPaths: Map<string, string>,
  addEdge: AddImportEdge,
): Promise<void> {
  if (!filePath.endsWith(".php")) return;
  for (const fqcn of extractPhpUseStatements(source)) {
    try {
      const resolved = await resolvePhpNamespace(index.repo, fqcn);
      if (!resolved.exists || !resolved.file_path) continue;
      const candidate = resolved.file_path.replace(/^\.\//, "");
      const targetFile = index.files.some((file) => file.path === candidate)
        ? candidate
        : normalizedPaths.get(candidate.replace(/\.php$/, "")) ?? null;
      if (targetFile && targetFile !== filePath) addEdge(filePath, targetFile);
    } catch {
      // Missing composer.json or malformed PSR-4 metadata contributes no edge.
    }
  }
}

/**
 * Returns whether the AST path handled the file. On `false` the caller runs the regex fallback —
 * previously there was none, so a parser failure deleted every import edge in the file silently.
 */
export async function collectPythonEdges(
  filePath: string,
  source: string,
  context: PythonImportContext,
  addEdge: AddImportEdge,
): Promise<{ astHandled: boolean }> {
  if (context.disabled || !filePath.endsWith(".py")) return { astHandled: true };
  try {
    const parser = await getParser("python");
    if (!parser) return { astHandled: false };
    let tree = getCachedParse("python", source);
    if (!tree) {
      tree = parser.parse(source);
      if (!tree) return { astHandled: false };
      setCachedParse("python", source, tree);
    }
    for (const imported of extractPythonImports(tree)) {
      const targetFile = resolvePythonImport(
        { module: imported.module, level: imported.level },
        filePath,
        context.indexedFiles,
        context.srcLayout,
      );
      if (targetFile) {
        addEdge(filePath, targetFile, {
          type_only: imported.is_type_only,
          star_import: imported.is_star,
        });
      }
    }
    return { astHandled: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[import-graph] python extraction failed for ${filePath}: ${message} — falling back to regex`,
    );
    return { astHandled: false };
  }
}

/** Regex-derived Python edges, resolved through the SAME resolver the AST path uses. */
export function collectPythonRegexEdges(
  filePath: string,
  source: string,
  context: PythonImportContext,
  addEdge: AddImportEdge,
): void {
  if (context.disabled || !filePath.endsWith(".py")) return;
  for (const imported of extractPythonImportsByRegex(source)) {
    const targetFile = resolvePythonImport(
      { module: imported.module, level: imported.level },
      filePath,
      context.indexedFiles,
      context.srcLayout,
    );
    if (targetFile) {
      addEdge(filePath, targetFile, { type_only: imported.is_type_only, star_import: imported.is_star });
    }
  }
}
