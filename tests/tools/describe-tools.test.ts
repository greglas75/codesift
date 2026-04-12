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
    // search_text has repo (optional, auto-resolved from CWD) and query (required) params
    const repo = tool.params.find(p => p.name === "repo");
    expect(repo).toBeDefined();
    expect(repo!.required).toBe(false);
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
  it("registers only core tools up front in deferred mode", () => {
    const mock = createMockServer();
    registerTools(mock as any, { deferNonCore: true });

    const allDefs = getToolDefinitions();
    expect(mock.registeredTools.size).toBeLessThan(allDefs.length);

    const searchTextHandle = mock.registeredTools.get("search_text");
    expect(searchTextHandle).toBeDefined();
    expect(searchTextHandle!.enabled).toBe(true);

    const storedCoreHandle = getToolHandle("search_text");
    expect(storedCoreHandle).toBeDefined();

    const deadCodeHandle = mock.registeredTools.get("find_dead_code");
    expect(deadCodeHandle).toBeUndefined();
    expect(getToolHandle("find_dead_code")).toBeUndefined();
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

    expect(mock.registeredTools.get("find_dead_code")).toBeUndefined();

    const describeHandle = mock.registeredTools.get("describe_tools");
    const handler = describeHandle!.handler as (args: Record<string, unknown>) => Promise<unknown>;

    // Call with reveal: true
    await handler({ names: ["find_dead_code"], reveal: true });

    const deadCodeHandle = mock.registeredTools.get("find_dead_code");
    expect(deadCodeHandle).toBeDefined();
    expect(deadCodeHandle!.enable).toHaveBeenCalled();
    expect(deadCodeHandle!.enabled).toBe(true);
  });
});
