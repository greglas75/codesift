import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { detectSrcLayout } from "../python-import-resolver.js";
import { createEdgeAccumulator, type EdgeAccumulator } from "./edge-accumulator.js";
import { buildKotlinFilesByBasename } from "./language-imports.js";
import { buildNormalizedPathMap } from "./path-map.js";
import { collectSourceEdges, type SourceEdgeContext } from "./source-edge-collector.js";
import type { ImportEdge, PythonImportContext, ImportGraphIndex } from "./types.js";
import { buildWorkspaceAliasResolver } from "./workspace-alias.js";

function buildPythonContext(index: ImportGraphIndex): PythonImportContext {
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

function buildSourceContext(index: ImportGraphIndex): CollectionContext {
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

/**
 * How many files to read at once. Enough to keep the disk busy, far below the descriptor limit —
 * an EMFILE is a harder failure than a slow scan, and this runs against repositories of 15,000+
 * files.
 */
const READ_BATCH = 32;

/** Collect all import edges between files in the index. */
export async function collectImportEdges(
  index: ImportGraphIndex,
  fileFilter?: Set<string>,
): Promise<ImportEdge[]> {
  const context = buildSourceContext(index);
  const files = fileFilter
    ? index.files.filter((file) => fileFilter.has(file.path))
    : index.files;

  // Read in parallel batches, process IN ORDER.
  //
  // The reads were sequential — one `await readFile` per file, 15,422 of them on
  // tgm-survey-platform — so nothing was computing for most of the scan; it was waiting for one
  // disk read at a time.
  //
  // Batched rather than one `Promise.all` over the whole list: 15,422 concurrent opens would trade
  // this for EMFILE, and a descriptor limit is a harder failure than a slow scan.
  //
  // Processing stays strictly in file order even though the reads no longer are.
  // `collectSourceEdges` appends to a shared accumulator, so out-of-order processing would reorder
  // the edge list — equivalent as a graph, different as a response, and every caller diffing
  // results across versions would see a change that is not one.
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = files.slice(i, i + READ_BATCH);
    const sources = await Promise.all(
      batch.map((file) => readFile(join(index.root, file.path), "utf-8").catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const source = sources[j];
      if (source === null || source === undefined) continue;
      await collectSourceEdges(batch[j]!.path, source, context);
    }
  }
  return context.accumulator.edges;
}
