import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANNOTATED_TOOL_NAMES, annotationConfig, toolAnnotations } from "../../../src/register-tools/annotations.js";
import { TOOL_DEFINITION_MAP } from "../../../src/register-tools/discovery.js";
import { startHttpServer } from "../../../src/server.js";

async function listToolsFromRealServer() {
  const h = await startHttpServer({ port: 0 });
  const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}?client=codex`)));
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await h.close();
  }
}

describe("tool annotations", () => {
  it("classifies every defined tool, so a new tool cannot ship without a decision", () => {
    const unclassified = [...TOOL_DEFINITION_MAP.keys()].filter((name) => toolAnnotations(name) === undefined);
    expect(unclassified).toEqual([]);
  });

  it("lists every tool once, so a writer cannot also sit in a read-only list", () => {
    const repeated = ANNOTATED_TOOL_NAMES.filter((name, i) => ANNOTATED_TOOL_NAMES.indexOf(name) !== i);
    expect(repeated).toEqual([]);
  });

  // Spelled out on purpose: reading these names from the table would pass for any table.
  it.each([
    "analyze_project", "architecture_summary", "consolidate_memories", "create_analysis_plan",
    "describe_tools", "generate_claude_md", "generate_report", "generate_wiki", "index_conversations",
    "index_file", "index_folder", "index_repo", "invalidate_cache", "journal_append", "plan_turn",
    "pope_insights_push_candidates", "react_quickstart", "rename_symbol", "repo_group",
    "scratchpad_write", "update_step_status",
  ])("does not report %s, which changes something, as read-only", (name) => {
    expect(toolAnnotations(name)?.readOnlyHint).toBe(false);
  });

  it.each(["rename_symbol", "consolidate_memories", "generate_claude_md", "invalidate_cache", "repo_group"])(
    "warns that %s can destroy what it replaces",
    (name) => {
      expect(toolAnnotations(name)?.destructiveHint).toBe(true);
    },
  );

  it.each(["index_repo", "pope_insights_push_candidates", "dependency_audit", "introspect_pg", "analyze_python_deps"])(
    "marks %s as reaching outside the machine",
    (name) => {
      expect(toolAnnotations(name)?.openWorldHint).toBe(true);
    },
  );

  it("does not retry tools whose second call has a new effect", () => {
    const hints = ["rename_symbol", "journal_append", "create_analysis_plan", "repo_group"]
      .map((name) => toolAnnotations(name)?.idempotentHint);
    expect(hints).toEqual([false, false, false, false]);
  });

  it("sends no hints for an unclassified tool, leaving the client's cautious defaults", () => {
    expect(annotationConfig("not_a_real_tool")).toEqual({});
  });

  it("hands each caller its own object, so one change cannot reach every tool on a preset", () => {
    const first = toolAnnotations("search_text");
    if (!first) throw new Error("search_text is not classified");
    first.readOnlyHint = false;
    expect(toolAnnotations("get_symbol")?.readOnlyHint).toBe(true);
  });

  it("sends each tool's hints through tools/list, and the table names only real tools", async () => {
    const tools = await listToolsFromRealServer();
    const wrong = tools
      .filter((t) => JSON.stringify(t.annotations) !== JSON.stringify(toolAnnotations(t.name)))
      .map((t) => t.name);
    expect(wrong).toEqual([]);

    const known = new Set([...TOOL_DEFINITION_MAP.keys(), ...tools.map((t) => t.name)]);
    expect(ANNOTATED_TOOL_NAMES.filter((name) => !known.has(name))).toEqual([]);
    expect(tools.find((t) => t.name === "rename_symbol")?.annotations?.destructiveHint).toBe(true);
  }, 120_000);
});
