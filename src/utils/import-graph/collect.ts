import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeIndex } from "../../types.js";
import { detectSrcLayout } from "../python-import-resolver.js";
import { createEdgeAccumulator, type EdgeAccumulator } from "./edge-accumulator.js";
import { buildKotlinFilesByBasename } from "./language-imports.js";
import { buildNormalizedPathMap } from "./path-map.js";
import { collectSourceEdges, type SourceEdgeContext } from "./source-edge-collector.js";
import type { ImportEdge, PythonImportContext } from "./types.js";
import { buildWorkspaceAliasResolver } from "./workspace-alias.js";

function buildPythonContext(index: CodeIndex): PythonImportContext {
  const indexedFiles = new Set(
    index.files.filter((file) => file.path.endsWith(".py")).map((file) => file.path),
  );
  return {
    disabled: process.env.CODESIFT_DISABLE_PYTHON_IMPORTS === "1",
    indexedFiles,
    srcLayout: indexedFiles.size > 0 ? detectSrcLayout([...indexedFiles]) : null,
  };
}

interface CollectionContext extends SourceEdgeContext {
  accumulator: EdgeAccumulator;
}

function buildSourceContext(index: CodeIndex): CollectionContext {
  const accumulator = createEdgeAccumulator();
  return {
    index,
    normalizedPaths: buildNormalizedPathMap(index),
    kotlinFilesByBasename: buildKotlinFilesByBasename(index),
    workspaceResolver: buildWorkspaceAliasResolver(index),
    python: buildPythonContext(index),
    addEdge: accumulator.add,
    accumulator,
  };
}

/** Collect all import edges between files in the index. */
export async function collectImportEdges(
  index: CodeIndex,
  fileFilter?: Set<string>,
): Promise<ImportEdge[]> {
  const context = buildSourceContext(index);
  const files = fileFilter
    ? index.files.filter((file) => fileFilter.has(file.path))
    : index.files;

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    await collectSourceEdges(file.path, source, context);
  }
  return context.accumulator.edges;
}
