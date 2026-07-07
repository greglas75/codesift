/**
 * Shared NestJS tool primitives.
 */

// ---------------------------------------------------------------------------
// Shared error type for per-file skip warnings (CQ8)
// ---------------------------------------------------------------------------

export interface NestToolError {
  file: string;
  reason: string;
}

/** DFS cycle detection on directed graph. Exported for reuse in nest-ext-tools.ts (G12). */
export function detectCycles(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    path.pop();
    inStack.delete(node);
  }

  for (const n of nodes) dfs(n);
  return cycles;
}
