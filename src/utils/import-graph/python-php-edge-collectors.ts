import { getCachedParse, setCachedParse } from "../../parser/parse-cache.js";
import { getParser } from "../../parser/parser-manager.js";
import { resolvePhpNamespace } from "../../tools/php-tools.js";
import type { CodeIndex } from "../../types.js";
import { extractPythonImports } from "../python-imports.js";
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

export async function collectPythonEdges(
  filePath: string,
  source: string,
  context: PythonImportContext,
  addEdge: AddImportEdge,
): Promise<void> {
  if (context.disabled || !filePath.endsWith(".py")) return;
  try {
    const parser = await getParser("python");
    if (!parser) return;
    let tree = getCachedParse("python", source);
    if (!tree) {
      tree = parser.parse(source);
      if (!tree) return;
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[import-graph] python extraction failed for ${filePath}: ${message}`);
  }
}
