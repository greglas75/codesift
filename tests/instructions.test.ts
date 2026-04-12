import { describe, it, expect } from "vitest";
import { CODESIFT_INSTRUCTIONS } from "../src/instructions.js";

describe("CODESIFT_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof CODESIFT_INSTRUCTIONS).toBe("string");
    expect(CODESIFT_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it("is under 5200 chars (~1300 tokens)", () => {
    // Bumped from 4000 as the tool catalog grew past 160 with full Hono
    // Phase 2 coverage in the TOOL MAPPING section.
    expect(CODESIFT_INSTRUCTIONS.length).toBeLessThan(5200);
  });

  it("contains tool discovery flow", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("discover_tools");
    expect(CODESIFT_INSTRUCTIONS).toContain("describe_tools");
  });

  it("contains hint code legend", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("H1");
    expect(CODESIFT_INSTRUCTIONS).toContain("H9");
  });

  it("contains ALWAYS and NEVER rules", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("ALWAYS");
    expect(CODESIFT_INSTRUCTIONS).toContain("NEVER");
  });

  it("contains key parameters", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("ranked");
    expect(CODESIFT_INSTRUCTIONS).toContain("detail_level");
    expect(CODESIFT_INSTRUCTIONS).toContain("token_budget");
  });

  it("contains cascade behavior", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("compact");
    expect(CODESIFT_INSTRUCTIONS).toContain("counts");
  });

  it("reports the merged MCP tool count", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("160 MCP tools");
  });

  it("mentions Hono Phase 2 tools in TOOL MAPPING", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("analyze_hono_app");
    expect(CODESIFT_INSTRUCTIONS).toContain("trace_middleware_chain");
    expect(CODESIFT_INSTRUCTIONS).toContain("only_conditional");
    expect(CODESIFT_INSTRUCTIONS).toContain("analyze_inline_handler");
  });

  it("does not reference tools merged out in consolidation", () => {
    expect(CODESIFT_INSTRUCTIONS).not.toContain("trace_conditional_middleware");
    expect(CODESIFT_INSTRUCTIONS).not.toContain("detect_middleware_env_regression");
  });
});
