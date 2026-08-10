import type { AddImportEdge, ImportEdge } from "./types.js";

export interface EdgeAccumulator {
  edges: ImportEdge[];
  add: AddImportEdge;
}

export function createEdgeAccumulator(): EdgeAccumulator {
  const edgeKeys = new Set<string>();
  const edges: ImportEdge[] = [];

  const add: AddImportEdge = (from, to, extras) => {
    if (to === from) return;
    const edgeKey = `${from}->${to}`;
    if (edgeKeys.has(edgeKey)) {
      if (!extras?.type_only) {
        const existing = edges.find((edge) => edge.from === from && edge.to === to);
        if (existing?.type_only) existing.type_only = false;
      }
      return;
    }

    edgeKeys.add(edgeKey);
    const edge: ImportEdge = { from, to };
    if (extras?.type_only) edge.type_only = true;
    if (extras?.star_import) edge.star_import = true;
    if (extras?.raw) edge.raw = extras.raw;
    edges.push(edge);
  };

  return { edges, add };
}
