import { describe, it, expect, vi } from "vitest";
import { describeTools, getToolDefinitions, registerTools, getToolHandle } from "../../src/register-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock that captures server.tool() calls and returns RegisteredTool-like handles */
function createMockServer() {
  const registeredTools = new Map<string, {
    name: string;
    enabled: boolean;
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    handler: unknown;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }>();
  return {
    registeredTools,
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      const handle = {
        name,
        enabled: true,
        disable: vi.fn(() => { handle.enabled = false; }),
        enable: vi.fn(() => { handle.enabled = true; }),
        handler,
        update: vi.fn(),
        remove: vi.fn(),
      };
      registeredTools.set(name, handle);
      return handle;
    }),
  };
}

// ---------------------------------------------------------------------------
// Unit tests — describeTools (from Task 3)
// ---------------------------------------------------------------------------

describe("describeTools", () => {
  it("returns full params for a known tool", () => {
    const result = describeTools(["search_text"]);
    expect(result.tools).toHaveLength(1);
    expect(result.not_found).toHaveLength(0);
    const tool = result.tools[0];
    expect(tool.name).toBe("search_text");
    expect(tool.category).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.is_core).toBe(true);
    expect(tool.params.length).toBeGreaterThan(0);
    // search_text has repo (required) and query (required) params
    const repo = tool.params.find(p => p.name === "repo");
    expect(repo).toBeDefined();
    expect(repo!.required).toBe(true);
    const query = tool.params.find(p => p.name === "query");
    expect(query).toBeDefined();
    expect(query!.required).toBe(true);
    const filePattern = tool.params.find(p => p.name === "file_pattern");
    expect(filePattern).toBeDefined();
    expect(filePattern!.required).toBe(false);
  });

  it("returns not_found for unknown tool", () => {
    const result = describeTools(["nonexistent_tool_xyz"]);
    expect(result.tools).toHaveLength(0);
    expect(result.not_found).toEqual(["nonexistent_tool_xyz"]);
  });

  it("returns partial results for mixed valid/invalid names", () => {
    const result = describeTools(["search_text", "nonexistent_tool_xyz"]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("search_text");
    expect(result.not_found).toEqual(["nonexistent_tool_xyz"]);
  });

  it("returns empty arrays for empty input", () => {
    const result = describeTools([]);
    expect(result.tools).toHaveLength(0);
    expect(result.not_found).toHaveLength(0);
  });

  it("correctly marks non-core tools", () => {
    const result = describeTools(["find_dead_code"]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].is_core).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — registerTools with deferNonCore + describe_tools MCP tool
// ---------------------------------------------------------------------------

describe("registerTools with deferNonCore", () => {
  it("stores tool handles and calls disable() on non-core tools", () => {
    const mock = createMockServer();
    registerTools(mock as any, { deferNonCore: true });

    // All tools should be registered (core + non-core + meta tools)
    const allDefs = getToolDefinitions();
    expect(mock.registeredTools.size).toBeGreaterThanOrEqual(allDefs.length);

    // Non-core tools should have disable() called
    for (const def of allDefs) {
      const handle = mock.registeredTools.get(def.name);
      expect(handle).toBeDefined();
      if (handle && !handle.name.startsWith("discover_") && !handle.name.startsWith("describe_")) {
        // Check via getToolHandle that handles are stored
        const storedHandle = getToolHandle(def.name);
        expect(storedHandle).toBeDefined();
      }
    }

    // Specifically check a known non-core tool was disabled
    const deadCodeHandle = mock.registeredTools.get("find_dead_code");
    expect(deadCodeHandle).toBeDefined();
    expect(deadCodeHandle!.disable).toHaveBeenCalled();
    expect(deadCodeHandle!.enabled).toBe(false);

    // A core tool should NOT have disable() called
    const searchTextHandle = mock.registeredTools.get("search_text");
    expect(searchTextHandle).toBeDefined();
    expect(searchTextHandle!.disable).not.toHaveBeenCalled();
    expect(searchTextHandle!.enabled).toBe(true);
  });

  it("registers describe_tools MCP tool with correct schema", () => {
    const mock = createMockServer();
    registerTools(mock as any, { deferNonCore: true });

    const describeHandle = mock.registeredTools.get("describe_tools");
    expect(describeHandle).toBeDefined();
    expect(describeHandle!.name).toBe("describe_tools");
  });

  it("describe_tools handler returns valid result for known tool", async () => {
    const mock = createMockServer();
    registerTools(mock as any, { deferNonCore: true });

    const describeHandle = mock.registeredTools.get("describe_tools");
    expect(describeHandle).toBeDefined();

    // Call the handler directly
    const handler = describeHandle!.handler as (args: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({ names: ["find_dead_code"] });

    // wrapTool returns { content: [{ type: "text", text: ... }] }
    expect(result).toBeDefined();
    const textContent = (result as any).content?.[0]?.text;
    expect(textContent).toBeDefined();
    const parsed = JSON.parse(textContent);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("find_dead_code");
    expect(parsed.not_found).toHaveLength(0);
  });

  it("describe_tools with reveal=true calls enable() on the tool handle", async () => {
    const mock = createMockServer();
    registerTools(mock as any, { deferNonCore: true });

    const deadCodeHandle = mock.registeredTools.get("find_dead_code");
    expect(deadCodeHandle).toBeDefined();
    expect(deadCodeHandle!.disable).toHaveBeenCalled();

    const describeHandle = mock.registeredTools.get("describe_tools");
    const handler = describeHandle!.handler as (args: Record<string, unknown>) => Promise<unknown>;

    // Call with reveal: true
    await handler({ names: ["find_dead_code"], reveal: true });

    // enable() should have been called on find_dead_code
    expect(deadCodeHandle!.enable).toHaveBeenCalled();
  });
});
