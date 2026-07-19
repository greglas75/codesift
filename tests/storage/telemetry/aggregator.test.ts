import { describe, it, expect } from "vitest";
import { aggregateToolMetrics } from "../../../src/storage/telemetry/aggregator.js";
import type { UsageEntry } from "../../../src/storage/usage-tracker.js";

const DAY = Date.UTC(2026, 6, 19, 12, 0, 0); // 2026-07-19

function entry(p: Partial<UsageEntry> & { tool: string; ts: number }): UsageEntry {
  return {
    repo: "", args_summary: {}, elapsed_ms: 0, result_tokens: 0,
    result_chunks: 1, session_id: "s", ...p,
  } as UsageEntry;
}

describe("aggregateToolMetrics", () => {
  it("computes count, latency percentiles, error_rate and empty_result_rate", () => {
    const entries: UsageEntry[] = [
      entry({ tool: "t", ts: DAY, elapsed_ms: 10, result_chunks: 1, error: false }),
      entry({ tool: "t", ts: DAY, elapsed_ms: 20, result_chunks: 0, error: false }),
      entry({ tool: "t", ts: DAY, elapsed_ms: 100, result_chunks: 5, error: true }),
    ];
    const aggs = aggregateToolMetrics(entries);
    expect(aggs).toHaveLength(1);
    const a = aggs[0]!;
    expect(a.tool).toBe("t");
    expect(a.day).toBe("2026-07-19");
    expect(a.count).toBe(3);
    expect(a.max_ms).toBe(100);
    expect(a.p95_ms).toBe(100);
    expect(a.error_rate).toBeCloseTo(1 / 3, 3);
    expect(a.empty_result_rate).toBeCloseTo(1 / 3, 3);
  });

  it("groups separately by tool and by UTC day", () => {
    const nextDay = DAY + 24 * 3600 * 1000;
    const aggs = aggregateToolMetrics([
      entry({ tool: "a", ts: DAY }),
      entry({ tool: "b", ts: DAY }),
      entry({ tool: "a", ts: nextDay }),
    ]);
    expect(aggs).toHaveLength(3);
    const key = (t: string, d: string) => aggs.find((x) => x.tool === t && x.day === d);
    expect(key("a", "2026-07-19")!.count).toBe(1);
    expect(key("a", "2026-07-20")!.count).toBe(1);
    expect(key("b", "2026-07-19")!.count).toBe(1);
  });

  it("ignores malformed entries (missing tool/ts)", () => {
    const aggs = aggregateToolMetrics([
      entry({ tool: "t", ts: DAY }),
      { tool: "t" } as unknown as UsageEntry, // no ts
      null as unknown as UsageEntry,
    ]);
    expect(aggs).toHaveLength(1);
    expect(aggs[0]!.count).toBe(1);
  });
});
