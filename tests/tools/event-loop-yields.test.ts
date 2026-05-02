import { describe, it, expect, vi } from "vitest";
import { findPerfHotspots } from "../../src/tools/perf-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: async (_repo: string): Promise<CodeIndex> => makeLargeIndex(20_000),
}));

function makeLargeIndex(n: number): CodeIndex {
  const symbols: CodeSymbol[] = [];
  // Mix of patterns: most symbols boring, every ~50th has a perf antipattern
  const sourceTemplates = [
    "function noop() { return 1; }",
    "function withReadFile() { const fs = require('fs'); fs.readFileSync('x'); }",
    "async function inLoop(items) { for (const i of items) { await fetch(i); } }",
    "function regexInLoop(arr) { for (const x of arr) { /a+b+c+d+/.test(x); } }",
  ];
  for (let i = 0; i < n; i++) {
    const tmpl = sourceTemplates[i % sourceTemplates.length]!;
    symbols.push({
      id: `t:f${i}.ts:fn${i}:1`,
      repo: "test",
      name: `fn${i}`,
      kind: "function",
      file: `src/f${i}.ts`,
      start_line: 1,
      end_line: 5,
      source: tmpl,
      signature: `function fn${i}()`,
    });
  }
  return {
    repo: "test",
    root: "/tmp/event-loop-yields-test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: n,
    file_count: 0,
  };
}

/**
 * Measures the maximum gap between successive `setImmediate` callbacks
 * during the execution of `task`. If the event loop is blocked by a
 * synchronous loop, callbacks queue up and the gap explodes.
 *
 * Returns `{ maxGapMs, taskMs }`.
 */
async function measureMaxEventLoopGap<T>(task: () => Promise<T>): Promise<{ maxGapMs: number; taskMs: number; result: T }> {
  const ticks: number[] = [Date.now()];
  let stop = false;
  const tick = (): void => {
    ticks.push(Date.now());
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);

  const t0 = Date.now();
  const result = await task();
  const taskMs = Date.now() - t0;
  stop = true;
  // Allow the final setImmediate to settle so we capture the post-task tick
  await new Promise((r) => setImmediate(r));

  let maxGapMs = 0;
  for (let i = 1; i < ticks.length; i++) {
    maxGapMs = Math.max(maxGapMs, ticks[i]! - ticks[i - 1]!);
  }
  return { maxGapMs, taskMs, result };
}

describe("event loop yields in heavy CodeSift tools", () => {
  it("findPerfHotspots yields at least every 100ms on a 20k-symbol index", async () => {
    // Without yields, this loop blocks the event loop for the full duration of the scan
    // (typically 200ms-2s+ depending on CPU). With yields every 512 iterations,
    // max gap should stay well under 100ms — leaving room for MCP ping responses.
    const { maxGapMs, taskMs } = await measureMaxEventLoopGap(() =>
      findPerfHotspots("test", { max_results: 1000 }),
    );

    // Sanity: the task did real work (not zero-cost short-circuit)
    expect(taskMs).toBeGreaterThan(20);

    // Core assertion: event loop was responsive throughout the scan
    expect(maxGapMs).toBeLessThan(100);
  }, 30_000);
});
