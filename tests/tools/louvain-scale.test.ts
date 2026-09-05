// Community detection has to finish on a repository-sized graph.
//
// Both places that needed `sigma_tot` — the summed degree of a community — recomputed it by
// scanning the ENTIRE community map: once per node for the current community, and again per node
// per NEIGHBOURING community for each candidate. That is O(N^2 * k) per pass, twenty passes.
//
// Measured on tgm-survey-platform with focus="src": 12,498 nodes, 36,338 edges. The import graph
// itself builds in 18.5 s; detect_communities did not return within 300 s, so effectively all of
// that was the rescan. The canonical algorithm keeps a running total and updates it on a move.
import { describe, it, expect } from "vitest";
import { louvain } from "../../src/tools/community-tools.js";

/** Deterministic pseudo-random graph — a fixed seed so a failure is reproducible. */
function graph(nodeCount: number, edgeCount: number, seed: number) {
  let s = seed;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nodes = Array.from({ length: nodeCount }, (_, i) => `f${i}`);
  const adj = new Map<string, Map<string, number>>(nodes.map((n) => [n, new Map<string, number>()]));
  for (let i = 0; i < edgeCount; i++) {
    const a = nodes[Math.floor(rnd() * nodeCount)]!;
    const b = nodes[Math.floor(rnd() * nodeCount)]!;
    if (a === b) continue;
    adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + 1);
    adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + 1);
  }
  return { nodes, adj };
}

describe("louvain at repository scale", () => {
  it("finishes a 12,000-node graph well inside a tool timeout", () => {
    // The size that did not return in 300 s. A generous bound rather than a tight one: this asserts
    // the complexity class changed, not a particular machine's speed.
    const { nodes, adj } = graph(12_000, 36_000, 42);
    const started = Date.now();
    const result = louvain(nodes, adj, 1.0);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.size).toBe(12_000);
  }, 60_000);

  it("assigns every node to exactly one community", () => {
    const { nodes, adj } = graph(500, 1_500, 7);
    const result = louvain(nodes, adj, 1.0);
    for (const node of nodes) expect(result.get(node)).toBeTypeOf("number");
  });

  it("numbers communities contiguously from zero", () => {
    const { nodes, adj } = graph(300, 900, 29);
    const ids = [...new Set(louvain(nodes, adj, 1.0).values())].sort((a, b) => a - b);
    expect(ids[0]).toBe(0);
    expect(ids[ids.length - 1]).toBe(ids.length - 1);
  });

  it("keeps an isolated node in its own community rather than dropping it", () => {
    // A file nothing imports is a real and common case; losing it silently would understate the
    // module count and make the map look tidier than the repository is.
    const adj = new Map<string, Map<string, number>>([
      ["a", new Map([["b", 1]])],
      ["b", new Map([["a", 1]])],
      ["lonely", new Map()],
    ]);
    const result = louvain(["a", "b", "lonely"], adj, 1.0);
    expect(result.has("lonely")).toBe(true);
    expect(result.get("lonely")).not.toBe(result.get("a"));
  });

  it("returns every node when the graph has no edges at all", () => {
    const adj = new Map<string, Map<string, number>>([["x", new Map()], ["y", new Map()]]);
    expect(louvain(["x", "y"], adj, 1.0).size).toBe(2);
  });
});
