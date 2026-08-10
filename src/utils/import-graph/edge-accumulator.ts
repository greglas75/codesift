import type { AddImportEdge, ImportEdge } from "./types.js";

export interface EdgeAccumulator {
  edges: ImportEdge[];
  add: AddImportEdge;
}

export function createEdgeAccumulator(): EdgeAccumulator {
  const edgesBySource = new Map<string, Map<string, ImportEdge>>();
  const edges: ImportEdge[] = [];

  const add: AddImportEdge = (from, to, extras) => {
    if (to === from) return;
    const existing = edgesBySource.get(from)?.get(to);
    if (existing) {
      const upgradedToRuntime = !extras?.type_only && existing.type_only === true;
      const addedStarImport = extras?.star_import && !existing.star_import;
      if (!extras?.type_only) {
        if (existing.type_only) existing.type_only = false;
      } else if (existing.type_only === undefined) {
        existing.type_only = false;
      }
      if (extras?.star_import) existing.star_import = true;
      if (upgradedToRuntime && !extras?.raw) {
        delete existing.raw;
      } else if (
        extras?.raw
        && (upgradedToRuntime || addedStarImport || !existing.raw)
        && (existing.type_only === true || !extras.type_only || addedStarImport)
      ) {
        existing.raw = extras.raw;
      }
      return;
    }

    const edge: ImportEdge = { from, to };
    if (extras?.type_only) edge.type_only = true;
    if (extras?.star_import) edge.star_import = true;
    if (extras?.raw) edge.raw = extras.raw;
    let targets = edgesBySource.get(from);
    if (!targets) {
      targets = new Map();
      edgesBySource.set(from, targets);
    }
    targets.set(to, edge);
    edges.push(edge);
  };

  return { edges, add };
}
