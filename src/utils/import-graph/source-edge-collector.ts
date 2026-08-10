import type { CodeIndex } from "../../types.js";
import { extractKotlinImports, resolveKotlinImport } from "./language-imports.js";
import { resolveImportPath } from "./path-map.js";
import { collectPhpEdges, collectPythonEdges } from "./python-php-edge-collectors.js";
import { extractBareImports, extractImports } from "./source-imports.js";
import type { AddImportEdge, PythonImportContext } from "./types.js";
import { collectTypeScriptEdges } from "./typescript-edge-collector.js";
import { NULL_RESOLVER, type WorkspaceAliasResolver } from "./workspace-alias.js";

export interface SourceEdgeContext {
  index: CodeIndex;
  normalizedPaths: Map<string, string>;
  kotlinFilesByBasename: Map<string, string[]>;
  workspaceResolver: WorkspaceAliasResolver;
  python: PythonImportContext;
  addEdge: AddImportEdge;
}

function collectRegexEdges(
  filePath: string,
  source: string,
  normalizedPaths: Map<string, string>,
  addEdge: AddImportEdge,
): void {
  for (const importPath of extractImports(source)) {
    const targetFile = normalizedPaths.get(resolveImportPath(filePath, importPath));
    if (targetFile) addEdge(filePath, targetFile);
  }
}

function collectWorkspaceEdges(
  filePath: string,
  source: string,
  resolver: WorkspaceAliasResolver,
  addEdge: AddImportEdge,
): void {
  if (resolver === NULL_RESOLVER || !/\.(astro|ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return;
  for (const importPath of extractBareImports(source)) {
    const targetFile = resolver.resolve(importPath, filePath);
    if (targetFile) addEdge(filePath, targetFile);
  }
}

function collectKotlinEdges(
  filePath: string,
  source: string,
  filesByBasename: Map<string, string[]>,
  addEdge: AddImportEdge,
): void {
  if (!/\.kts?$/.test(filePath)) return;
  for (const fqName of extractKotlinImports(source)) {
    const targetFile = resolveKotlinImport(fqName, filesByBasename);
    if (targetFile) addEdge(filePath, targetFile);
  }
}

export async function collectSourceEdges(
  filePath: string,
  source: string,
  context: SourceEdgeContext,
): Promise<void> {
  const typescript = await collectTypeScriptEdges(
    context.index,
    filePath,
    source,
    context.normalizedPaths,
    context.addEdge,
  );
  if (typescript.skipFile) return;
  if (!typescript.astHandled) {
    collectRegexEdges(filePath, source, context.normalizedPaths, context.addEdge);
  }
  collectWorkspaceEdges(filePath, source, context.workspaceResolver, context.addEdge);
  collectKotlinEdges(filePath, source, context.kotlinFilesByBasename, context.addEdge);
  await collectPhpEdges(context.index, filePath, source, context.normalizedPaths, context.addEdge);
  await collectPythonEdges(filePath, source, context.python, context.addEdge);
}
