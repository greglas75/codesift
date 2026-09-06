import { readFile } from "node:fs/promises";
import { loadEdgeCache, saveEdgeCache, type CachedEdgeCall, type EdgeCache } from "./edge-cache.js";
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

  // Profiled on tgm-survey-platform (16,896 files, 149 MB): reading every file is 0.8 s, extracting
  // its imports is 14.8 s — 95% of this function. Parsing is a pure function of the content, so an
  // unchanged file never needs it twice.
  //
  // The cache is keyed on the WHOLE FILE SET as well as per-file mtime: `import "./foo"` resolves
  // against the paths that exist, so adding or deleting a file elsewhere can change where an
  // untouched file points. `loadEdgeCache` returns null on that, and everything is reparsed.
  const cache = index.indexPath === undefined
    ? null
    : await loadEdgeCache(index.indexPath, index.files);
  const nextCache: EdgeCache = new Map();
  let reused = 0;

  // The accumulator merges by (from, to); recording the CALLS rather than the merged edges is what
  // lets a replay reproduce the merge exactly instead of reimplementing its rules.
  let recording: CachedEdgeCall[] | null = null;
  const baseAdd = context.addEdge;
  const recordingAdd: typeof baseAdd = (from, to, extras) => {
    if (recording !== null) recording.push(extras === undefined ? { to } : { to, extras });
    baseAdd(from, to, extras);
  };
  context.addEdge = recordingAdd;

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
      const file = batch[j]!;
      const source = sources[j];
      if (source === null || source === undefined) continue;

      const hit = cache?.get(file.path);
      if (hit !== undefined && file.mtime_ms !== undefined && hit.mtime === file.mtime_ms) {
        for (const call of hit.calls) baseAdd(file.path, call.to, call.extras);
        nextCache.set(file.path, hit);
        reused++;
        continue;
      }

      recording = [];
      await collectSourceEdges(file.path, source, context);
      if (file.mtime_ms !== undefined) {
        nextCache.set(file.path, { mtime: file.mtime_ms, calls: recording });
      }
      recording = null;
    }
  }

  // Written only for a FULL collection. A filtered run saw a subset of the files, so persisting it
  // would produce a cache that looks complete and answers for a fraction of the repository — the
  // failure mode a cache must never have.
  if (index.indexPath !== undefined && fileFilter === undefined) {
    void saveEdgeCache(index.indexPath, index.files, nextCache).catch(() => {});
  }
  if (reused > 0 && process.env["CODESIFT_DEBUG_EDGE_CACHE"] === "1") {
    console.error(`[import-graph] reused ${reused}/${files.length} cached file(s)`);
  }
  return context.accumulator.edges;
}
