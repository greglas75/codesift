import { describe, it, expect, vi } from "vitest";
import { findPerfHotspots } from "../../src/tools/perf-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// findPerfHotspots reads through the narrow accessors (ADR-004 stage 2). The helper delivers a
// stream as ONE batch — the shape of a resident index — which is the worst case for yielding.
vi.mock("../../src/tools/index-tools.js", async () => {
  const { narrowIndexMock } = await import("../helpers/narrow-index-mock.js");
  return narrowIndexMock(async (_repo: unknown): Promise<CodeIndex> => makeLargeIndex(20_000));
});

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
 * Counts how often the event loop got a turn while `task` ran: a `setImmediate` chain that re-arms
 * itself fires once per loop turn, so it can only advance when the task awaits a macrotask. A
 * synchronous scan gives it no turn at all.
 *
 * It counts turns, not milliseconds. The old version asserted the longest gap between turns was
 * under 100 ms, which a loaded CI runner broke on its own ("expected 126 to be less than 100", run
 * 41577995004 on a docs-only PR); how often the scan yields does not depend on the host.
 */
async function countEventLoopTurns<T>(task: () => Promise<T>): Promise<{ turns: number; result: T }> {
  let turns = 0;
  let stop = false;
  const tick = (): void => {
    turns++;
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  const result = await task();
  stop = true;
  return { turns, result };
}

describe("event loop yields in heavy CodeSift tools", () => {
  it("findPerfHotspots gives the event loop a turn at least every 512 symbols of a 20k-symbol scan", async () => {
    // Bug caught: a scan that stops yielding (or yields far less often) blocks the MCP transport
    // for the whole scan, and the client drops the connection (-32000). The scan yields every 256
    // symbols, 78 turns over 20 000; the floor is half that, so retuning the interval to 512 still
    // passes while removing the yield (0 turns until the scan ends) fails. A limit the scan cannot
    // reach keeps it from stopping early at max_results.
    const { turns, result } = await countEventLoopTurns(() =>
      findPerfHotspots("test", { max_results: 1_000_000 }),
    );

    expect(result.findings.length).toBeGreaterThan(0);
    expect(turns).toBeGreaterThanOrEqual(Math.floor(20_000 / 512));
  }, 30_000);
});
