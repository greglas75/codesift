import { describe, expect, it } from "vitest";
import { buildArgsSummary } from "../../src/storage/usage-tracker.js";

/**
 * The argument that decides the response size has to be the one the row names. find_references
 * answers in two very different shapes — a single symbol renders as per-file text, a batch returns
 * a structured object — and the batch argument was invisible: the generic pass-through copies only
 * scalars, so `symbol_names` was dropped and a batch call logged `repo` alone. 1,120 of 3,005 real
 * calls (37%) had exactly that shape, which made the two paths impossible to tell apart.
 */
describe("buildArgsSummary — find_references", () => {
  it("records how many symbols a batch call asked for", () => {
    const s = buildArgsSummary("find_references", { repo: "local/x", symbol_names: ["a", "b", "c"] });
    expect(s["symbol_count"]).toBe(3);
  });

  it("records max_refs, which bounds the response", () => {
    const s = buildArgsSummary("find_references", { repo: "local/x", symbol_name: "a", max_refs: 200 });
    expect(s["max_refs"]).toBe(200);
  });

  // Names are the one thing that must NOT be logged: the summary is local-only today, but symbol
  // names carry the shape of private code and the counts answer the size question by themselves.
  it("records the count, never the names", () => {
    const s = buildArgsSummary("find_references", { repo: "local/x", symbol_names: ["secretInternalThing"] });
    expect(JSON.stringify(s)).not.toContain("secretInternalThing");
  });

  it("leaves the single-symbol shape as it was", () => {
    const s = buildArgsSummary("find_references", { repo: "local/x", symbol_name: "a" });
    expect(s["symbol_count"]).toBeUndefined();
  });
});
