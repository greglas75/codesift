import { describe, it, expect } from "vitest";

describe("runtime dependencies", () => {
  it("graphology-metrics/centrality/pagerank resolves and exports pagerank()", async () => {
    const mod = await import("graphology-metrics/centrality/pagerank");
    expect(typeof mod.default).toBe("function");
  });
});
