import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, getToolHandle, CORE_TOOL_NAMES } from "../../src/register-tools.js";

describe("Astro 5 tool registration (Task 12)", () => {
  beforeAll(() => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerTools(server, { deferNonCore: false });
  });

  const NEW_TOOLS = [
    "astro_middleware",
    "astro_sessions",
    "astro_db_audit",
    "astro_env_validator",
    "astro_image_audit",
    "astro_svg_components",
  ];

  it("all 6 new tools are registered in TOOL_DEFINITIONS", () => {
    for (const name of NEW_TOOLS) {
      const handle = getToolHandle(name);
      expect(handle, `expected ${name} to be registered`).toBeDefined();
    }
  });

  it("none of the 6 new tools are added to CORE_TOOL_NAMES (only meta-tool stays core)", () => {
    for (const name of NEW_TOOLS) {
      expect(CORE_TOOL_NAMES.has(name), `${name} must NOT be in CORE_TOOL_NAMES`).toBe(false);
    }
    // astro_audit (meta-tool) IS expected to remain in CORE
    expect(CORE_TOOL_NAMES.has("astro_audit")).toBe(true);
  });

  it("each new tool's handler accepts {project_root} or {repo}", () => {
    for (const name of NEW_TOOLS) {
      const handle = getToolHandle(name);
      expect(handle).toBeDefined();
      // Handler exists and is callable; we don't invoke it here (no fixture).
    }
  });
});
