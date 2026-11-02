import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANNOTATED_TOOL_NAMES, annotationConfig, toolAnnotations } from "../../../src/register-tools/annotations.js";
import { TOOL_DEFINITION_MAP } from "../../../src/register-tools/discovery.js";
import { startHttpServer } from "../../../src/server.js";

/** Registered directly in register-tools.ts, so TOOL_DEFINITION_MAP never holds them. */
const META_TOOLS = ["discover_tools", "describe_tools"];

describe("tool annotations", () => {
  it("classifies every registered tool, so a new tool cannot ship without a decision", () => {
    const unclassified = [...TOOL_DEFINITION_MAP.keys(), ...META_TOOLS]
      .filter((name) => toolAnnotations(name) === undefined);
    expect(unclassified).toEqual([]);
  });

  it("lists no name that is not a tool, so a typo cannot silently drop a tool's hints", () => {
    const known = new Set([...TOOL_DEFINITION_MAP.keys(), ...META_TOOLS]);
    expect(ANNOTATED_TOOL_NAMES.filter((name) => !known.has(name))).toEqual([]);
  });

  it("lists every tool once, so a writer cannot also sit in a read-only list", () => {
    const repeated = ANNOTATED_TOOL_NAMES.filter((name, i) => ANNOTATED_TOOL_NAMES.indexOf(name) !== i);
    expect(repeated).toEqual([]);
  });

  it.each([
    ["rewrites source files", "rename_symbol"],
    ["writes .zuvo/project-profile.json", "analyze_project"],
    ["writes the profile through analyzeProject", "architecture_summary"],
    ["writes the profile through analyzeProject", "react_quickstart"],
    ["writes codesift-report.html", "generate_report"],
    ["overwrites MEMORY.md", "consolidate_memories"],
    ["removes a group", "repo_group"],
    ["POSTs with dry_run=false", "pope_insights_push_candidates"],
  ])("does not report a tool that %s as read-only: %s", (_effect, name) => {
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

  it("sends no hints for an unclassified tool, leaving the client's cautious defaults", () => {
    expect(annotationConfig("not_a_real_tool")).toEqual({});
  });

  it("reaches a real client through tools/list, or the table protects nobody", async () => {
    const h = await startHttpServer({ port: 0 });
    try {
      const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.url}?client=codex`)));
      const { tools } = await client.listTools();
      await client.close();

      const hintsOf = (name: string) => tools.find((t) => t.name === name)?.annotations;
      expect(hintsOf("search_text")?.readOnlyHint).toBe(true);
      expect(hintsOf("rename_symbol")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(hintsOf("discover_tools")?.readOnlyHint).toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);
});
