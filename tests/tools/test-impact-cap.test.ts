import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/register-tool-groups/index.js";

const def = TOOL_DEFINITIONS.find((t) => t.name === "test_impact_analysis");
const schemaOf = () => {
  const s = typeof def!.schema === "function" ? (def!.schema as () => Record<string, { description?: string; _def?: { description?: string } }>)() : def!.schema;
  return s as Record<string, { description?: string; _def?: { description?: string } }>;
};
const desc = (k: string) => String(schemaOf()[k]?.description ?? schemaOf()[k]?._def?.description ?? "");

/**
 * Nothing bounded the affected-test list. Telemetry over 33 calls: a 3,150-token median against a
 * 272,637-token maximum — the largest single response in the whole corpus, and past any context
 * window. The cap is also a correctness fix: the suggested command inlines every path (8,140 B for
 * 207 tests), so at a few thousand tests it exceeds ARG_MAX and cannot run.
 */
describe("test_impact_analysis output cap", () => {
  it("exposes max_tests", () => {
    expect(def).toBeDefined();
    expect(Object.keys(schemaOf())).toContain("max_tests");
  });

  it("keeps the highest-confidence tests when it cuts", () => {
    expect(desc("max_tests")).toMatch(/confidence/i);
  });

  // A truncated list that does not say so turns "these are the affected tests" into a claim that is
  // simply false — and the agent would run a partial suite believing it was complete.
  it("promises to report the overflow", () => {
    expect(desc("max_tests")).toMatch(/overflow/i);
  });
});
