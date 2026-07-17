import { describe, expect, it } from "vitest";
import {
  formatTable,
  formatSearchSymbols,
  formatFileTree,
  formatFileOutline,
  formatSearchPatterns,
  formatDeadCode,
  formatComplexity,
  formatClones,
  formatHotspots,
  formatRepoOutline,
  formatSuggestQueries,
  formatSecrets,
  formatConversations,
  formatRoles,
  formatAssembleContext,
  formatCallTree,
  formatTraceRoute,
  formatDiffOutline,
  formatChangedSymbols,
  formatImpactAnalysis,
  formatKnowledgeMap,
  formatCommunities,
  formatReviewDiff,
  formatPerfHotspots,
  formatFanInFanOut,
  formatCoChange,
  formatArchitectureSummary,
  formatNextjsComponents,
  formatNextjsRouteMap,
  formatNextjsMetadataAudit,
  formatNextjsAuditServerActions,
  formatNextjsApiContract,
  formatNextjsBoundaryAnalyzer,
  formatNextjsDataFlow,
  formatNextjsMiddlewareCoverage,
  formatFrameworkAudit,
  formatNextjsLinkIntegrity,
} from "../../src/formatters.js";

type FormatterCase = [name: string, format: () => string, marker: string];

const symbol = {
  file: "src/example.ts",
  start_line: 4,
  kind: "function",
  name: "example",
  signature: "example(): number",
  source: "return 42;",
};

const route = {
  path: "/users",
  handlers: [{ file: "src/routes.ts", symbol }],
  call_chain: [{ name: "listUsers", file: "src/users.ts", kind: "function", depth: 0 }],
  db_calls: [{ symbol_name: "findMany", file: "src/users.ts", line: 12, operation: "findMany" }],
  middleware: { file: "src/auth.ts", matchers: ["/users"], applies: true },
  layout_chain: ["src/layout.ts"],
  server_actions: [{ name: "refresh", file: "src/actions.ts", called_from: "src/users.ts" }],
};

const formatterCases: FormatterCase[] = [
  ["formatTable", () => formatTable(["Name"], [["example"]]), "Name"],
  ["formatSearchSymbols", () => formatSearchSymbols([{ symbol, score: 1 }]), "src/example.ts:4"],
  ["formatFileTree", () => formatFileTree([{ path: "src/example.ts", symbols: 1 }]), "src/example.ts"],
  ["formatFileOutline", () => formatFileOutline({ symbols: [{ ...symbol, id: "example", end_line: 8 }] }), "example"],
  ["formatSearchPatterns", () => formatSearchPatterns({
    matches: [{ ...symbol, context: "example context" }],
    pattern: "TODO",
    scanned_symbols: 1,
  }), "TODO"],
  ["formatDeadCode", () => formatDeadCode({
    candidates: [{ ...symbol, end_line: 8 }],
    scanned_symbols: 1,
    scanned_files: 1,
  }), "scanned 1 symbols"],
  ["formatComplexity", () => formatComplexity({
    functions: [{ ...symbol, lines: 5, cyclomatic_complexity: 2, max_nesting_depth: 1 }],
    summary: { avg_complexity: 2, max_complexity: 2, total_functions: 1 },
  }), "avg_complexity=2"],
  ["formatClones", () => formatClones({
    clones: [{
      symbol_a: { name: "left", file: "src/left.ts", start_line: 1 },
      symbol_b: { name: "right", file: "src/right.ts", start_line: 2 },
      similarity: 0.8,
      shared_lines: 4,
    }],
    scanned_symbols: 2,
    threshold: 0.7,
  }), "80%"],
  ["formatHotspots", () => formatHotspots({
    hotspots: [{ file: "src/example.ts", commits: 2, lines_changed: 8, symbol_count: 1, hotspot_score: 16 }],
    period: "90d",
  }), "period: 90d"],
  ["formatRepoOutline", () => formatRepoOutline({
    directories: [{ path: "src", file_count: 1, symbol_count: 1, languages: ["typescript"] }],
    total_symbols: 1,
    total_files: 1,
  }), "1 files, 1 symbols"],
  ["formatSuggestQueries", () => formatSuggestQueries({
    top_files: [{ path: "src/example.ts", symbols: 1 }],
    kind_distribution: { function: 1 },
    example_queries: ["find example"],
  }), "find example"],
  ["formatSecrets", () => formatSecrets({
    findings: [{ rule: "test-rule", masked_secret: "***", confidence: "high", severity: "high", file: "src/example.ts", line: 4 }],
    files_scanned: 1,
    files_with_secrets: 1,
  }), "test-rule"],
  ["formatConversations", () => formatConversations([{ session_id: "s1", timestamp: "2026-07-12T00:00:00Z", user_question: "question", assistant_answer: "answer", score: 1 }]), "question"],
  ["formatRoles", () => formatRoles([{ name: "example", kind: "function", file: "src/example.ts", role: "leaf", callers: 1, callees: 0 }]), "leaf"],
  ["formatAssembleContext", () => formatAssembleContext({
    level: "L1",
    total_tokens: 3,
    truncated: false,
    result_count: 1,
    compact_symbols: [{ name: "example", kind: "function", file: "src/example.ts", start_line: 4, signature: "example()" }],
  }), "level=L1"],
  ["formatCallTree", () => formatCallTree({ symbol, children: [] }), "src/example.ts:4"],
  ["formatTraceRoute", () => formatTraceRoute(route), "route: /users"],
  ["formatDiffOutline", () => formatDiffOutline({ added: [symbol], modified: [], deleted: [] }), "added (1)"],
  ["formatChangedSymbols", () => formatChangedSymbols([{ file: "src/example.ts", symbols: ["example"] }]), "example"],
  ["formatImpactAnalysis", () => formatImpactAnalysis({
    changed_files: ["src/example.ts"],
    affected_symbols: [symbol],
    affected_tests: [{ test_file: "tests/example.test.ts", reason: "changed" }],
    risk_scores: [{ file: "src/example.ts", risk: "high", score: 9 }],
    dependency_graph: { "src/example.ts": ["src/dependency.ts"] },
  }), "changed: src/example.ts"],
  ["formatKnowledgeMap", () => formatKnowledgeMap({
    modules: [{ path: "src/example.ts", symbol_count: 1 }],
    edges: [{ from: "src/example.ts", to: "src/dependency.ts" }],
    circular_deps: [{ cycle: ["src/example.ts", "src/dependency.ts"] }],
  }), "1 modules, 1 edges"],
  ["formatCommunities", () => formatCommunities({
    communities: [{ id: 1, name: "core", files: ["src/example.ts"], symbol_count: 1, internal_edges: 1, external_edges: 0, cohesion: 1 }],
    modularity: 0.5,
    total_files: 1,
  }), "1 communities"],
  ["formatReviewDiff", () => formatReviewDiff({
    verdict: "pass",
    score: 100,
    diff_stats: { files_reviewed: 1 },
    duration_ms: 2,
    checks: [{ check: "complexity", status: "pass", summary: "clean" }],
    findings: [],
  }), "review_diff: pass"],
  ["formatPerfHotspots", () => formatPerfHotspots({
    findings: [{ pattern: "n-plus-one", severity: "high", file: "src/example.ts", line: 4, name: "example", kind: "function", context: "query in loop", fix_hint: "batch it" }],
    patterns_checked: 6,
    symbols_scanned: 1,
    summary: { high: 1, medium: 0, low: 0 },
  }), "perf_hotspots: 1 findings"],
  ["formatFanInFanOut", () => formatFanInFanOut({
    fan_in_top: [{ file: "src/example.ts", count: 2, connections: ["src/a.ts"] }],
    fan_out_top: [{ file: "src/example.ts", count: 1, connections: ["src/a.ts"] }],
    hub_files: [{ file: "src/example.ts", count: 3, connections: ["in=2", "out=1"] }],
    coupling_score: 80,
    total_files: 2,
    total_edges: 3,
  }), "fan_in_fan_out: 2 files"],
  ["formatCoChange", () => formatCoChange({
    pairs: [{ file_a: "src/example.ts", file_b: "src/a.ts", co_commits: 2, jaccard: 0.5, support_a: 2, support_b: 3 }],
    clusters: [["src/example.ts", "src/a.ts"]],
    total_commits_analyzed: 3,
    period: "90d",
  }), "co_change: 1 coupled pairs"],
  ["formatArchitectureSummary", () => formatArchitectureSummary({
    stack: { summary: "TypeScript" },
    communities: [{ id: 1, name: "core", files: ["src/example.ts"], symbol_count: 1, internal_edges: 1, external_edges: 0, cohesion: 1 }],
    coupling_hotspots: [{ file: "src/example.ts", count: 2, connections: ["src/a.ts"] }],
    circular_deps: [["src/example.ts", "src/a.ts"]],
    loc_distribution: [{ dir: "src", file_count: 1, symbol_count: 1 }],
    entry_points: ["src/example.ts"],
    duration_ms: 2,
  }), "architecture_summary (2ms)"],
  ["formatNextjsComponents", () => formatNextjsComponents({
    files: [{ path: "app/page.tsx", violations: ["use_client"] }],
    counts: { total: 1, server: 1, client_explicit: 0, client_inferred: 0, ambiguous: 0, unnecessary_use_client: 0 },
    parse_failures: [],
    scan_errors: [],
    truncated: false,
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS COMPONENT ANALYSIS"],
  ["formatNextjsRouteMap", () => formatNextjsRouteMap({
    routes: [{ url_path: "/", type: "page", rendering: "static", router: "app", has_metadata: true }],
    conflicts: [],
    middleware: null,
    workspaces_scanned: ["app"],
    scan_errors: [],
    truncated: false,
  }), "NEXT.JS ROUTE MAP"],
  ["formatNextjsMetadataAudit", () => formatNextjsMetadataAudit({
    total_pages: 1,
    scores: [{ url_path: "/", file_path: "app/page.tsx", score: 90, grade: "excellent", violations: [], missing_fields: [] }],
    counts: { excellent: 1, good: 0, needs_work: 0, poor: 0 },
    top_issues: [],
    workspaces_scanned: ["app"],
    parse_failures: [],
    scan_errors: [],
    limitations: [],
  }), "NEXT.JS METADATA AUDIT"],
  ["formatNextjsAuditServerActions", () => formatNextjsAuditServerActions({
    total: 1,
    actions: [{ name: "save", file: "app/actions.ts", score: 90, grade: "good", auth: { confidence: "high" }, input_validation: { lib: "zod" }, rate_limiting: { lib: "none" }, error_handling: { has_try_catch: true } }],
    counts: { excellent: 0, good: 1, needs_work: 0, poor: 0 },
    violations: [],
    parse_failures: [],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS SERVER ACTIONS SECURITY AUDIT"],
  ["formatNextjsApiContract", () => formatNextjsApiContract({
    total: 1,
    completeness_score: 100,
    handlers: [{ method: "GET", path: "/api/users", request_schema: { resolved: true }, response_shapes: [{ type: "User[]" }], inferred_status_codes: [200] }],
    parse_failures: [],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS API CONTRACT"],
  ["formatNextjsBoundaryAnalyzer", () => formatNextjsBoundaryAnalyzer({
    client_count: 1,
    total_client_loc: 10,
    entries: [{ rank: 1, path: "app/page.tsx", signals: { loc: 10, import_count: 2 }, score: 5 }],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS CLIENT BOUNDARY ANALYZER"],
  ["formatNextjsDataFlow", () => formatNextjsDataFlow({
    total_pages: 1,
    total_waterfalls: 0,
    cache_summary: { cached: 1 },
    entries: [{ url_path: "/", fetches: [], waterfall_count: 0 }],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS DATA FLOW"],
  ["formatNextjsMiddlewareCoverage", () => formatNextjsMiddlewareCoverage({
    total: 1,
    coverage: { protected: ["/admin"], unprotected: [] },
    warnings: [],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS MIDDLEWARE COVERAGE"],
  ["formatFrameworkAudit", () => formatFrameworkAudit({
    summary: { overall_score: 90, grade: "A", dimensions: { security: { score: 90, weight: 1, contribution: 90 } }, top_issues: [] },
    duration_ms: 2,
    tool_errors: [],
  }), "NEXT.JS FRAMEWORK AUDIT"],
  ["formatNextjsLinkIntegrity", () => formatNextjsLinkIntegrity({
    total_refs: 1,
    resolved_count: 0,
    broken_count: 1,
    unresolved_count: 0,
    broken: [{ href: "/missing", file: "app/page.tsx", line: 1 }],
    unresolved: [],
    workspaces_scanned: ["app"],
    limitations: [],
  }), "NEXT.JS LINK INTEGRITY"],
];

describe("formatters characterization", () => {
  it("covers every exported formatter unit before the split", () => {
    expect(formatterCases).toHaveLength(37);
  });

  it.each(formatterCases)("preserves %s output", (_name, format, marker) => {
    const output = format();
    expect(output).toContain(marker);
    expect(output.length).toBeGreaterThan(marker.length);
  });
});
