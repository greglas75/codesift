import { describe, it, expect } from "vitest";
import { CODESIFT_INSTRUCTIONS } from "../src/instructions.js";

describe("CODESIFT_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof CODESIFT_INSTRUCTIONS).toBe("string");
    expect(CODESIFT_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it("is under 4000 chars (~1000 tokens)", () => {
    expect(CODESIFT_INSTRUCTIONS.length).toBeLessThan(4000);
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
    expect(CODESIFT_INSTRUCTIONS).toContain("116 MCP tools");
  });
});
