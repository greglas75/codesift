import { describe, expect, it } from "vitest";
import { FORMATTER_DISPATCH, dispatchFormatter } from "../../src/formatter-dispatch.js";

const EXPECTED_FORMATTER_KEYS = [
  "search_symbols",
  "get_file_tree",
  "get_file_outline",
  "search_patterns",
  "find_dead_code",
  "analyze_complexity",
  "find_clones",
  "analyze_hotspots",
  "get_repo_outline",
  "suggest_queries",
  "scan_secrets",
  "search_conversations",
  "find_conversations_for_symbol",
  "search_all_conversations",
  "classify_roles",
  "assemble_context",
  "trace_call_chain",
  "trace_route",
  "diff_outline",
  "changed_symbols",
  "impact_analysis",
  "get_knowledge_map",
  "detect_communities",
  "review_diff",
  "find_perf_hotspots",
  "fan_in_fan_out",
  "co_change_analysis",
  "architecture_summary",
  "analyze_nextjs_components",
  "nextjs_route_map",
  "nextjs_metadata_audit",
  "nextjs_audit_server_actions",
  "nextjs_api_contract",
  "nextjs_boundary_analyzer",
  "nextjs_data_flow",
  "nextjs_middleware_coverage",
  "framework_audit",
  "nextjs_link_integrity",
] as const;

describe("formatter dispatch map", () => {
  it("registers every tool-facing formatter exactly once", () => {
    expect(Object.keys(FORMATTER_DISPATCH)).toEqual([...EXPECTED_FORMATTER_KEYS]);
  });

  it("dispatches core formatter output by MCP tool name", () => {
    const output = dispatchFormatter("search_symbols", [{
      symbol: { file: "src/example.ts", start_line: 4, kind: "function", name: "example" },
      score: 1,
    }]);
    expect(output).toContain("src/example.ts:4");
  });

  it("dispatches framework formatter output by MCP tool name", () => {
    const output = dispatchFormatter("framework_audit", {
      summary: {
        overall_score: 90,
        grade: "A",
        dimensions: { security: { score: 90, weight: 1, contribution: 90 } },
        top_issues: [],
      },
      duration_ms: 2,
      tool_errors: [],
    });
    expect(output).toContain("NEXT.JS FRAMEWORK AUDIT");
  });
});
