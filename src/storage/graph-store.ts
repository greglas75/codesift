import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./_shared.js";

/**
 * Persistent knowledge graph — caches symbol relationships (import edges,
 * call chains, type usage) across sessions to avoid expensive recomputation.
 *
 * Stored as JSON alongside the index file. Invalidated when the index changes
 * (via content hash comparison).
 */

export interface GraphEdge {
  from: string;  // source file or symbol
  to: string;    // target file or symbol
  kind: "imports" | "calls" | "uses_type" | "extends" | "implements";
}

export interface PersistentGraph {
  /** Hash of the index content — used to detect staleness */
  index_hash: string;
  /** Timestamp of last computation */
  computed_at: number;
  /** Import edges between files */
  edges: GraphEdge[];
  /** Module-level stats */
  modules: Array<{ path: string; symbol_count: number; in_degree: number; out_degree: number }>;
  /** Detected circular dependencies */
  circular_deps: string[][];
}

/**
 * Get the graph store path from an index path.
 * {hash}.index.json → {hash}.graph.json
 */
export function getGraphPath(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, ".graph.json");
}

/** Simple FNV-1a hash for content-change detection. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Compute a hash from index file paths + symbol counts (cheap staleness check). */
export function computeIndexHash(files: Array<{ path: string; symbol_count: number }>): string {
  const fingerprint = files.map((f) => `${f.path}:${f.symbol_count}`).join("\n");
  return fnv1a(fingerprint);
}

/**
 * Load a persisted graph. Returns null if not found, corrupted, or stale.
 */
export async function loadGraph(
  graphPath: string,
  currentIndexHash: string,
): Promise<PersistentGraph | null> {
  try {
    const raw = await readFile(graphPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as Record<string, unknown>)["index_hash"] === "string" &&
      Array.isArray((parsed as Record<string, unknown>)["edges"])
    ) {
      const graph = parsed as PersistentGraph;
      // Stale check: index changed since last computation
      if (graph.index_hash !== currentIndexHash) return null;
      return graph;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save a computed graph to disk.
 */
export async function saveGraph(
  graphPath: string,
  graph: PersistentGraph,
): Promise<void> {
  await atomicWriteFile(graphPath, JSON.stringify(graph));
}
