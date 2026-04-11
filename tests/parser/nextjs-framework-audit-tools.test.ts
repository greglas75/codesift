import { describe, it, expect, vi, beforeAll } from "vitest";
import { resolve } from "node:path";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  frameworkAudit,
  aggregateScores,
} from "../../src/tools/nextjs-framework-audit-tools.js";
import type { AuditDimension } from "../../src/tools/nextjs-framework-audit-tools.js";

describe("nextjs-framework-audit-tools exports", () => {
  it("exports frameworkAudit function", () => {
    expect(typeof frameworkAudit).toBe("function");
  });

  it("exports aggregateScores function", () => {
    expect(typeof aggregateScores).toBe("function");
  });
});

describe("aggregateScores", () => {
  it("returns 100 / excellent for all-perfect sub_results", () => {
    const summary = aggregateScores({
      metadata: {
        total_pages: 1,
        counts: { excellent: 1, good: 0, needs_work: 0, poor: 0 },
      },
      security: { actions: [{ score: 100 }] },
      components: { counts: { total: 1, unnecessary_use_client: 0 } },
    });
    expect(summary.overall_score).toBeGreaterThanOrEqual(90);
    expect(summary.grade).toBe("excellent");
  });

  it("returns weighted average for mixed scores", () => {
    const summary = aggregateScores({
      metadata: {
        total_pages: 2,
        counts: { excellent: 1, good: 1, needs_work: 0, poor: 0 },
      },
      security: { actions: [{ score: 80 }] },
    });
    expect(summary.overall_score).toBeGreaterThanOrEqual(60);
  });

  it("ignores undefined sub_results from weighting", () => {
    const summary = aggregateScores({
      metadata: {
        total_pages: 1,
        counts: { excellent: 1, good: 0, needs_work: 0, poor: 0 },
      },
    });
    expect(summary.dimensions.metadata).toBeDefined();
    expect(summary.dimensions.security).toBeUndefined();
  });

  it("returns poor / 0 for empty sub_results", () => {
    const summary = aggregateScores({});
    expect(summary.overall_score).toBe(0);
    expect(summary.grade).toBe("poor");
  });
});

describe("frameworkAudit dispatcher", () => {
  const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-app-router");

  beforeAll(() => {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-app-router",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
  });

  it("invokes a default subset of sub-tools without errors", async () => {
    const result = await frameworkAudit("nextjs-app-router", {
      tools: ["metadata", "components"],
    });
    expect(result.tool_errors).toEqual([]);
    expect(result.summary).toBeDefined();
  });

  it("only invokes specified tools when subset given", async () => {
    const result = await frameworkAudit("nextjs-app-router", {
      tools: ["metadata"] as AuditDimension[],
    });
    expect(result.sub_results.metadata).toBeDefined();
    expect(result.sub_results.security).toBeUndefined();
  });
});

describe("frameworkAudit integration", () => {
  const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-app-router");

  beforeAll(() => {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-app-router",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
  });

  it("runs full audit on real fixture without crashes", async () => {
    const result = await frameworkAudit("nextjs-app-router");
    expect(result.summary.overall_score).toBeGreaterThanOrEqual(0);
    expect(Object.keys(result.sub_results).length).toBeGreaterThanOrEqual(1);
  });

  it("subset run only populates requested dimensions", async () => {
    const result = await frameworkAudit("nextjs-app-router", {
      tools: ["metadata", "boundary"],
    });
    expect(result.sub_results.metadata).toBeDefined();
    expect(result.sub_results.boundary).toBeDefined();
    expect(result.sub_results.security).toBeUndefined();
  });
});

describe("frameworkAudit memory", () => {
  const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-app-router");

  it("stays under 200MB peak RSS for fixture audit", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-app-router",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);

    if (typeof process.memoryUsage !== "function") return;
    const before = process.memoryUsage().rss;
    await frameworkAudit("nextjs-app-router");
    const after = process.memoryUsage().rss;
    const deltaMb = (after - before) / (1024 * 1024);
    // Generous bound — informational, not strict
    expect(deltaMb).toBeLessThan(200);
  });
});
