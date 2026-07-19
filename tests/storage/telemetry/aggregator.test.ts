import { describe, it, expect } from "vitest";
import { aggregateToolMetrics, aggregateHintFunnel, aggregatePlanTurnFunnel } from "../../../src/storage/telemetry/aggregator.js";
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

  it("counts cache hits toward cache_hit_rate but excludes them from latency/error/empty", () => {
    const aggs = aggregateToolMetrics([
      entry({ tool: "t", ts: DAY, elapsed_ms: 40, result_chunks: 2, error: false }),
      entry({ tool: "t", ts: DAY, cache_hit: true, elapsed_ms: 0, result_chunks: 0 }),
      entry({ tool: "t", ts: DAY, cache_hit: true, elapsed_ms: 0, result_chunks: 0 }),
    ]);
    const a = aggs[0]!;
    expect(a.count).toBe(3); // total invocations
    expect(a.cache_hit_rate).toBeCloseTo(2 / 3, 3);
    expect(a.max_ms).toBe(40); // only the executed call
    expect(a.empty_result_rate).toBe(0); // cache hits NOT counted as empty
    expect(a.error_rate).toBe(0);
  });

  it("aggregateHintFunnel counts emitted vs applied via next-call correlation", () => {
    // H1 emitted on call 1; call 2 (same session) uses group_by_file → applied.
    // H4 emitted on call 2; call 3 does NOT add file_pattern → emitted-not-applied.
    const hints = aggregateHintFunnel([
      entry({ tool: "search_text", ts: DAY, session_id: "s", hints_emitted: ["H1"] }),
      entry({ tool: "search_text", ts: DAY + 1, session_id: "s", hints_emitted: ["H4"], args_summary: { group_by_file: true } }),
      entry({ tool: "search_symbols", ts: DAY + 2, session_id: "s", args_summary: {} }),
    ]);
    const h1 = hints.find((h) => h.hint_code === "H1")!;
    expect(h1.emitted).toBe(1);
    expect(h1.applied).toBe(1); // next call had group_by_file:true
    const h4 = hints.find((h) => h.hint_code === "H4")!;
    expect(h4.emitted).toBe(1);
    expect(h4.applied).toBe(0); // next call lacked file_pattern
  });

  it("aggregatePlanTurnFunnel counts recommended vs used", () => {
    const pt = aggregatePlanTurnFunnel([
      entry({ tool: "plan_turn", ts: DAY, session_id: "s", recommended_tools: ["search_text", "get_symbol"] }),
      entry({ tool: "search_text", ts: DAY + 1, session_id: "s" }), // used a recommendation
      entry({ tool: "plan_turn", ts: DAY + 2, session_id: "s", recommended_tools: ["trace_route"] }),
      entry({ tool: "search_text", ts: DAY + 3, session_id: "s" }), // did NOT use recommendation
    ]);
    expect(pt).toHaveLength(1);
    expect(pt[0]!.recommended).toBe(2);
    expect(pt[0]!.used).toBe(1);
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
