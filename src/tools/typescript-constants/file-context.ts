import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node as TSNode } from "web-tree-sitter";
import { resolveImportPath } from "../../utils/import-graph.js";
import type {
  AssignmentBinding,
  DefaultExportBinding,
  ImportBinding,
  ResolutionState,
  TypeScriptFileContext,
} from "./types.js";

const MAX_TS_RESOLVER_FILE_CACHE = 128;

function trimResolverFileCache(state: ResolutionState): void {
  const cache = state.fileCache;
  while (cache.size > MAX_TS_RESOLVER_FILE_CACHE) {
    const first = cache.keys().next().value as string | undefined;
    if (first === undefined) break;
    const context = cache.get(first);
    if (context) state.retiredTrees.push(context.tree);
    cache.delete(first);
  }
}

function disposeTypeScriptFileContexts(state: ResolutionState): void {
  for (const context of state.fileCache.values()) {
    context?.tree.delete();
  }
  for (const tree of state.retiredTrees) {
    tree.delete();
  }
  state.fileCache.clear();
  state.retiredTrees.length = 0;
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

function stripTypeScriptString(text: string): string {
  const match = text.match(/^(['"`])([\s\S]*)\1$/);
  if (match) return match[2] ?? "";
  return text;
}

function getStringLiteralText(node: TSNode): string {
  const fragment = node.namedChildren.find((child) => child.type === "string_fragment");
  if (fragment) return fragment.text;
  return stripTypeScriptString(node.text);
}

function collectVariableDeclarators(
  node: TSNode,
  assignments: Map<string, AssignmentBinding>,
): void {
  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
    const valueNode = child.childForFieldName("value") ?? child.namedChildren[1];
    if (!nameNode || !valueNode || nameNode.type !== "identifier") continue;
    assignments.set(nameNode.text, {
      rhs: valueNode,
      line: child.startPosition.row + 1,
    });
  }
}

function collectImportBindings(
  node: TSNode,
  importerFile: string,
  normalizedPaths: Map<string, string>,
  imports: Map<string, ImportBinding>,
): void {
  if (node.children.some((child) => child.type === "type")) return;

  const stringNode = node.namedChildren.find((child) => child.type === "string");
  if (!stringNode) return;

  const rawPath = getStringLiteralText(stringNode);
  if (!rawPath.startsWith(".")) return;

  const normalized = resolveImportPath(importerFile, rawPath);
  const resolvedFile = normalizedPaths.get(normalized);
  if (!resolvedFile || !isTypeScriptFile(resolvedFile)) return;

  const importClause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!importClause) return;

  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      imports.set(child.text, {
        kind: "default",
        source_file: resolvedFile,
        line: node.startPosition.row + 1,
      });
      continue;
    }

    if (child.type === "named_imports") {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        if (specifier.children.some((entry) => entry.type === "type")) continue;
        const importedNode = specifier.namedChildren[0];
        const localNode = specifier.namedChildren[1] ?? importedNode;
        if (!importedNode || !localNode || localNode.type !== "identifier" || importedNode.type !== "identifier") continue;
        imports.set(localNode.text, {
          kind: "named",
          imported_name: importedNode.text,
          source_file: resolvedFile,
          line: node.startPosition.row + 1,
        });
      }
      continue;
    }

    if (child.type === "namespace_import") {
      const localNode = child.namedChildren.find((entry) => entry.type === "identifier");
      if (!localNode) continue;
      imports.set(localNode.text, {
        kind: "namespace",
        source_file: resolvedFile,
        line: node.startPosition.row + 1,
      });
    }
  }
}

function extractDefaultExport(node: TSNode): DefaultExportBinding | undefined {
  if (!node.text.startsWith("export default")) return undefined;

  const inner = node.namedChildren[0];
  if (!inner) {
    return {
      line: node.startPosition.row + 1,
    };
  }

  if (inner.type === "function_declaration" || inner.type === "class_declaration") {
    const nameNode = inner.childForFieldName("name") ?? inner.namedChildren[0];
    if (nameNode?.type === "identifier") {
      return {
        name: nameNode.text,
        line: node.startPosition.row + 1,
      };
    }
  }

  if (inner.type === "lexical_declaration") {
    const declarator = inner.namedChildren.find((child) => child.type === "variable_declarator");
    const nameNode = declarator?.childForFieldName("name") ?? declarator?.namedChildren[0];
    if (nameNode?.type === "identifier") {
      return {
        name: nameNode.text,
        line: node.startPosition.row + 1,
      };
    }
  }

  return {
    node: inner,
    line: node.startPosition.row + 1,
  };
}

async function loadTypeScriptFileContext(
  state: ResolutionState,
  filePath: string,
): Promise<TypeScriptFileContext | null> {
  const cache = state.fileCache;
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  if (!isTypeScriptFile(filePath)) {
    cache.set(filePath, null);
    return null;
  }

  let source: string;
  try {
    source = await readFile(join(state.index.root, filePath), "utf-8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err
      ? String((err as NodeJS.ErrnoException).code)
      : "";
    if (code !== "ENOENT") throw err;
    cache.set(filePath, null);
    return null;
  }

  const tree = state.parser.parse(source);
  if (!tree) {
    cache.set(filePath, null);
    return null;
  }
  const assignments = new Map<string, AssignmentBinding>();
  const imports = new Map<string, ImportBinding>();
  const normalizedPaths = state.normalizedPathMap;
  let defaultExport: DefaultExportBinding | undefined;

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "lexical_declaration") {
      collectVariableDeclarators(node, assignments);
      continue;
    }

    if (node.type === "import_statement") {
      collectImportBindings(node, filePath, normalizedPaths, imports);
      continue;
    }

    if (node.type === "export_statement") {
      const inner = node.namedChildren[0];
      if (inner?.type === "lexical_declaration") {
        collectVariableDeclarators(inner, assignments);
      }
      const exportBinding = extractDefaultExport(node);
      if (exportBinding) defaultExport = exportBinding;
    }
  }

  const context: TypeScriptFileContext = {
    source,
    tree,
    assignments,
    imports,
  };
  if (defaultExport) context.default_export = defaultExport;

  cache.set(filePath, context);
  trimResolverFileCache(state);
  return context;
}

export {
  disposeTypeScriptFileContexts,
  isTypeScriptFile,
  loadTypeScriptFileContext,
  stripTypeScriptString,
};
