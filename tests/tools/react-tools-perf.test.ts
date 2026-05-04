import { describe, it, expect } from "vitest";
import {
  buildJsxAdjacency,
  buildReverseAdjacency,
  computePropChainDepth,
} from "../../src/tools/react-tools.js";
import type { CodeSymbol } from "../../src/types.js";

/**
 * Tier 5 — Performance gate (Task 13 of plan-revision 5).
 *
 * Verifies that the memoized iterative implementation of computePropChainDepth
 * holds at scale: a 5,000-component synthetic graph must complete in <1s wall-clock
 * with every entry returning a finite numeric depth.
 *
 * Lives in a dedicated file (NOT tests/tools/react-tools.test.ts) so it has zero
 * file overlap with Tasks 10-12 — was the resolution to gemini + codex Run 3
 * "false disjointness" CRITICAL finding.
 */

function sym(overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "id" | "name" | "file">): CodeSymbol {
  return {
    repo: "test",
    kind: "component",
    start_line: 1,
    end_line: 20,
    ...overrides,
  };
}

describe("Tier 5 — analyzeRenders perf gate", () => {
  it("computePropChainDepth completes within 1s on 5000-component synthetic graph end-to-end", () => {
    // Build a 5000-component DAG: each component renders the next 2 deeper components,
    // simulating a realistic fan-out pattern (not just a linear chain).
    const N = 5000;
    const symbols: CodeSymbol[] = [];
    for (let i = 0; i < N; i++) {
      const sources: string[] = [];
      // Each component renders next-1 and next-2 (forming a Fibonacci-like DAG)
      if (i + 1 < N) sources.push(`<C${i + 1}/>`);
      if (i + 2 < N) sources.push(`<C${i + 2}/>`);
      if (sources.length === 0) sources.push("<div/>");
      symbols.push(
        sym({
          id: `C${i}`,
          name: `C${i}`,
          file: `c${i}.tsx`,
          source: sources.join(""),
        }),
      );
    }

    const adjacency = buildJsxAdjacency(symbols);
    const reverseAdj = buildReverseAdjacency(adjacency);

    // Iterate REVERSE order (gemini Run 6 finding): topological 0→N order hits memo
    // cache instantly and bypasses the deep-traversal logic the gate aims to stress.
    // Reverse order forces the algorithm to resolve deep unmemoized parent chains.
    const start = performance.now();
    const memo = new Map<string, number>();
    const depths: number[] = new Array(N);
    for (let i = N - 1; i >= 0; i--) {
      // Fresh inProgress per call — avoids cross-iteration leakage if the algorithm
      // ever exits abnormally without cleaning the shared set (gemini WARNING).
      depths[i] = computePropChainDepth(symbols[i]!.id, reverseAdj, memo, new Set<string>());
    }
    const elapsed = performance.now() - start;

    // Performance gate — generous 1s bound; typical local <100ms, CI <500ms.
    expect(elapsed).toBeLessThan(1000);

    // Correctness sanity: every entry has a finite numeric depth.
    expect(depths.length).toBe(N);
    for (const d of depths) {
      expect(typeof d).toBe("number");
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }

    // The deepest leaf should have depth proportional to chain length —
    // not something pathological like 0 or NaN.
    const maxDepth = Math.max(...depths);
    expect(maxDepth).toBeGreaterThan(100);
  });
});
