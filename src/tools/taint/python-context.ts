import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node as TSNode } from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import { detectSrcLayout, resolvePythonImport } from "../../utils/python-import-resolver.js";
import {
  findFunctionNode,
  getAttributePath,
  getImportModule,
  getParameterName,
} from "./taint-model.js";
import type {
  AnalysisState,
  CallableContext,
  FileImportBinding,
  PythonFileContext,
} from "./taint-model.js";

async function loadFileContext(
  state: AnalysisState,
  filePath: string,
): Promise<PythonFileContext | null> {
  const cached = state.fileContextCache.get(filePath);
  if (cached !== undefined) return cached;

  let source: string;
  try {
    source = await readFile(join(state.index.root, filePath), "utf-8");
  } catch {
    state.fileContextCache.set(filePath, null);
    return null;
  }

  const tree = state.pythonParser.parse(source);
  if (!tree) return null;
  const files = state.index.files.map((entry) => entry.path);
  const srcLayout = detectSrcLayout(files);
  const imports = new Map<string, FileImportBinding>();

  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== "import_from_statement") continue;
    const { module, level } = getImportModule(node);
    const resolvedFile = resolvePythonImport({ module, level }, filePath, files, srcLayout);
    if (!resolvedFile) continue;

    for (const child of node.namedChildren) {
      if (child.type === "aliased_import") {
        const importedNode = child.namedChildren[0];
        const aliasNode = child.namedChildren[1];
        if (importedNode && aliasNode) {
          imports.set(aliasNode.text, {
            imported_name: importedNode.text,
            source_file: resolvedFile,
            line: node.startPosition.row + 1,
          });
        }
        continue;
      }

      if (child.type === "dotted_name") {
        const importedName = child.text;
        const localName = importedName.split(".").pop() ?? importedName;
        imports.set(localName, {
          imported_name: importedName,
          source_file: resolvedFile,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  const context: PythonFileContext = { imports };
  state.fileContextCache.set(filePath, context);
  return context;
}

function hasPotentialSource(symbol: CodeSymbol): boolean {
  return symbol.source?.includes("request.") ?? false;
}

function hasPotentialSink(symbol: CodeSymbol): boolean {
  const source = symbol.source ?? "";
  return source.includes("mark_safe")
    || source.includes("redirect(")
    || source.includes(".execute(")
    || source.includes("subprocess.")
    || source.includes("requests.")
    || source.includes("httpx.")
    || source.includes("open(")
    || source.includes("request.session");
}

async function loadCallableContext(
  symbol: CodeSymbol,
  state: AnalysisState,
): Promise<CallableContext | null> {
  const cached = state.callableCache.get(symbol.id);
  if (cached !== undefined) return cached;
  if (!symbol.source) {
    state.callableCache.set(symbol.id, null);
    return null;
  }

  const tree = state.pythonParser.parse(symbol.source);
  if (!tree) return null;
  const functionNode = findFunctionNode(tree.rootNode);
  if (!functionNode) {
    state.callableCache.set(symbol.id, null);
    return null;
  }

  const paramsNode = functionNode.childForFieldName("parameters");
  const parameterNames = paramsNode
    ? paramsNode.namedChildren
      .map(getParameterName)
      .filter((name): name is string => Boolean(name))
    : [];

  const context: CallableContext = {
    node: functionNode,
    parameter_names: parameterNames,
  };
  state.callableCache.set(symbol.id, context);
  return context;
}

function resolveSelfMethod(
  currentSymbol: CodeSymbol,
  propertyName: string,
  state: AnalysisState,
): CodeSymbol | null {
  if (!currentSymbol.parent) return null;
  const methods = state.methodsByParent.get(currentSymbol.parent) ?? [];
  return methods.find((symbol) => symbol.name === propertyName) ?? null;
}

async function resolveHelperTarget(
  currentSymbol: CodeSymbol,
  calleeNode: TSNode,
  state: AnalysisState,
): Promise<CodeSymbol | null> {
  const calleeText = getAttributePath(calleeNode) ?? calleeNode.text;
  if (calleeNode.type === "identifier") {
    const sameFile = (state.symbolsByName.get(calleeText) ?? [])
      .filter((symbol) =>
        symbol.file === currentSymbol.file
        && symbol.id !== currentSymbol.id
        && (symbol.kind === "function" || symbol.kind === "class" || symbol.kind === "method")
      );
    if (sameFile.length === 1) return sameFile[0] ?? null;

    const fileContext = await loadFileContext(state, currentSymbol.file);
    const imported = fileContext?.imports.get(calleeText);
    if (imported) {
      const importedMatch = (state.symbolsByName.get(imported.imported_name) ?? [])
        .find((symbol) => symbol.file === imported.source_file);
      if (importedMatch) return importedMatch;
    }

    const unique = (state.symbolsByName.get(calleeText) ?? [])
      .filter((symbol) => symbol.file.endsWith(".py") && symbol.id !== currentSymbol.id)
      .filter((symbol) => symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class");
    if (unique.length === 1) return unique[0] ?? null;
    return null;
  }

  if (calleeNode.type === "attribute") {
    const objectNode = calleeNode.childForFieldName("object") ?? calleeNode.namedChild(0);
    const propertyNode = calleeNode.childForFieldName("attribute") ?? calleeNode.namedChild(1);
    const objectName = getAttributePath(objectNode);
    const propertyName = propertyNode?.text;

    if ((objectName === "self" || objectName === "cls") && propertyName) {
      return resolveSelfMethod(currentSymbol, propertyName, state);
    }

    const importedModule = objectName ? (await loadFileContext(state, currentSymbol.file))?.imports.get(objectName) : null;
    if (importedModule && propertyName) {
      const candidates = state.symbolsByName.get(propertyName) ?? [];
      const importedMatch = candidates.find((symbol) => symbol.file === importedModule.source_file);
      if (importedMatch) return importedMatch;
    }
  }

  return null;
}

export {
  hasPotentialSink,
  hasPotentialSource,
  loadCallableContext,
  loadFileContext,
  resolveHelperTarget,
};
