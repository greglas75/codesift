import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getParser } from "../../parser/parser-manager.js";
import { resolvePythonImport, detectSrcLayout } from "../../utils/python-import-resolver.js";
import type { CodeIndex } from "../../types.js";
import type {
  AssignmentBinding,
  ImportBinding,
  PythonFileContext,
} from "./model.js";
import { getImportModule } from "./syntax.js";

async function loadPythonFileContext(
  index: CodeIndex,
  filePath: string,
  cache: Map<string, PythonFileContext | null>,
): Promise<PythonFileContext | null> {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  if (!filePath.endsWith(".py")) {
    cache.set(filePath, null);
    return null;
  }

  const parser = await getParser("python");
  if (!parser) {
    cache.set(filePath, null);
    return null;
  }

  let source: string;
  try {
    source = await readFile(join(index.root, filePath), "utf-8");
  } catch {
    cache.set(filePath, null);
    return null;
  }

  const tree = parser.parse(source);
  if (!tree) {
    cache.set(filePath, null);
    return null;
  }
  const files = index.files.map((entry) => entry.path);
  const srcLayout = detectSrcLayout(files);
  const assignments = new Map<string, AssignmentBinding>();
  const imports = new Map<string, ImportBinding>();

  for (const node of tree.rootNode.namedChildren) {
    if (node.type === "expression_statement") {
      const inner = node.namedChildren[0];
      if (inner?.type === "assignment") {
        const lhs = inner.childForFieldName("left");
        const rhs = inner.childForFieldName("right");
        if (lhs?.type === "identifier" && rhs) {
          assignments.set(lhs.text, {
            rhs,
            line: node.startPosition.row + 1,
          });
        }
      }
      continue;
    }

    if (node.type === "import_from_statement") {
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
  }

  const context: PythonFileContext = {
    source,
    tree,
    assignments,
    imports,
  };
  cache.set(filePath, context);
  return context;
}

export { loadPythonFileContext };
