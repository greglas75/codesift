import { describe, it, expect } from "vitest";
import { CODESIFT_INSTRUCTIONS } from "../src/instructions.js";

describe("CODESIFT_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof CODESIFT_INSTRUCTIONS).toBe("string");
    expect(CODESIFT_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it("is under 6000 chars (~1500 tokens)", () => {
    // Budget grew to 6000 as more framework aliases were added (React,
    // Astro, Next.js, Hono Phase 2 tool shortcuts). Still well within
    // the MCP instructions envelope.
    expect(CODESIFT_INSTRUCTIONS.length).toBeLessThan(6000);
  });

  it("contains tool discovery flow", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("discover_tools");
    expect(CODESIFT_INSTRUCTIONS).toContain("describe_tools");
  });

  it("contains hint code legend including H12, H13, H14", () => {
    expect(CODESIFT_INSTRUCTIONS).toContain("H1");
    expect(CODESIFT_INSTRUCTIONS).toContain("H9");
    expect(CODESIFT_INSTRUCTIONS).toContain("H12");
    expect(CODESIFT_INSTRUCTIONS).toContain("H13");
    expect(CODESIFT_INSTRUCTIONS).toContain("H14");
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
    // Auto-adapts as tools grow — matches any 160-199 range so each
    // tool-count bump doesn't require a test update.
    expect(CODESIFT_INSTRUCTIONS).toMatch(/1[4-9]\d MCP tools/);
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
