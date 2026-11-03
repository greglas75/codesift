import { describe, it, expect, vi, beforeEach } from "vitest";
import { findPerfHotspots } from "../../src/tools/perf-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// Hoisted with the mock factory that reads them. `sourceRead` holds the symbols the scan has read so
// far: every symbol's `source` is a getter that records it.
const { SYMBOLS, sourceRead } = vi.hoisted(() => ({ SYMBOLS: 20_000, sourceRead: new Set<string>() }));

beforeEach(() => sourceRead.clear());

// findPerfHotspots reads through the narrow accessors (ADR-004 stage 2). The helper delivers a
// stream as ONE batch — the shape of a resident index — which is the worst case for yielding.
vi.mock("../../src/tools/index-tools.js", async () => {
  const { narrowIndexMock } = await import("../helpers/narrow-index-mock.js");
  return narrowIndexMock(async (_repo: unknown): Promise<CodeIndex> => makeLargeIndex(SYMBOLS));
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
    const id = `t:f${i}.ts:fn${i}:1`;
    const symbol: CodeSymbol = {
      id,
      repo: "test",
      name: `fn${i}`,
      kind: "function",
      file: `src/f${i}.ts`,
      start_line: 1,
      end_line: 5,
      signature: `function fn${i}()`,
    };
    Object.defineProperty(symbol, "source", {
      enumerable: true,
      get: () => { sourceRead.add(id); return tmpl; },
    });
    symbols.push(symbol);
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
 * The most symbols the scan read between two event-loop turns. A self-re-arming `setImmediate`
 * fires once per loop turn and samples how many symbols have been read so far, so the largest step
 * between samples is the longest stretch the scan ran without giving the loop a turn.
 *
 * It counts symbols, not milliseconds. The old version asserted the longest gap between turns was
 * under 100 ms, which a loaded CI runner broke on its own ("expected 126 to be less than 100", run
 * 41577995004 on a docs-only PR).
 */
async function longestStretchWithoutATurn(task: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [0];
  let stop = false;
  const tick = (): void => {
    samples.push(sourceRead.size);
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    await task();
  } finally {
    stop = true;
  }
  samples.push(sourceRead.size);
  let longest = 0;
  for (let i = 1; i < samples.length; i++) longest = Math.max(longest, samples[i]! - samples[i - 1]!);
  return longest;
}

describe("event loop yields in heavy CodeSift tools", () => {
  it("findPerfHotspots reads at most 512 symbols between event-loop turns on a 20k-symbol index", async () => {
    // Bug caught: a scan that stops yielding (or yields far less often) blocks the MCP transport
    // for the whole scan, and the client drops the connection (-32000). The scan yields every 256
    // symbols; without the yield the whole 20 000 are read in one stretch. 512 leaves room to
    // retune the interval. The limit is one the scan cannot reach, so it reads every symbol.
    const longest = await longestStretchWithoutATurn(() =>
      findPerfHotspots("test", { max_results: 1_000_000 }),
    );

    expect(sourceRead.size).toBe(SYMBOLS);
    expect(longest).toBeLessThanOrEqual(512);
  }, 30_000);
});
