// `error_class` exists so a failure in usage.jsonl can be diagnosed at all — `error: true` said a
// call failed and nothing else. It must stay LOCAL.
//
// The L1 payload is anonymous by omission: it names each field it emits, and the first-run notice
// tells the user which dimensions leave the machine. An error class is a new dimension. Adding it
// to the payload may well be the right call one day, but it is a deliberate decision that also
// changes the notice — not something that should happen by accident because a field was added to
// UsageEntry and the aggregator happened to spread it.
//
// This test is the tripwire for that accident.
import { describe, it, expect } from "vitest";
import { aggregateToolMetrics } from "../../../src/storage/telemetry/aggregator.js";
import type { UsageEntry } from "../../../src/storage/usage-tracker.js";

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    ts: Date.parse("2026-08-16T10:00:00Z"),
    tool: "search_text",
    repo: "local/secret-project",
    args_summary: {},
    elapsed_ms: 5,
    result_tokens: 10,
    result_chunks: 0,
    session_id: "s1",
    ...over,
  } as UsageEntry;
}

describe("error_class never leaves the machine", () => {
  it("is absent from every aggregated tool row", () => {
    const rows = aggregateToolMetrics([
      entry({ error: true, error_class: "repo_not_indexed" }),
      entry({ error: true, error_class: "git_failed" }),
      entry(),
    ]);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("error_class");
      // Serialised too — a getter or a nested carrier would pass a key check and still ship.
      expect(JSON.stringify(row)).not.toMatch(/error_class|repo_not_indexed|git_failed/);
    }
  });

  it("still counts those calls as errors, so the rate does not change", () => {
    // The class is withheld; the FACT of the failure is not. Dropping the error from the rate to
    // avoid leaking its class would trade one blind spot for a worse one.
    const rows = aggregateToolMetrics([
      entry({ error: true, error_class: "git_failed" }),
      entry(),
    ]);
    const row = rows.find((r) => r.tool === "search_text");
    expect(row?.error_rate).toBeCloseTo(0.5, 5);
  });
});
