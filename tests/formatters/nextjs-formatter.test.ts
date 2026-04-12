import { describe, it, expect } from "vitest";
import { formatNextjsComponents, formatNextjsRouteMap, formatNextjsBoundaryAnalyzer } from "../../src/formatters.js";
import type { NextjsBoundaryResult } from "../../src/tools/nextjs-boundary-tools.js";
import type { NextjsComponentsResult } from "../../src/tools/nextjs-component-tools.js";
import type { NextjsRouteMapResult } from "../../src/tools/nextjs-route-tools.js";
import { getToolDefinitions, CORE_TOOL_NAMES } from "../../src/register-tools.js";
import { formatNextjsRouteMapCompact, formatNextjsRouteMapCounts } from "../../src/formatters-shortening.js";

describe("formatNextjsComponents", () => {
  it("renders counts and violations", () => {
    const result: NextjsComponentsResult = {
      files: [
        {
          path: "app/page.tsx",
          classification: "server",
          directive: null,
          signals: { hooks: [], event_handlers: [], browser_globals: [], dynamic_ssr_false: false },
          violations: [],
        },
        {
          path: "app/components/UnnecessaryClient.tsx",
          classification: "client_explicit",
          directive: "use client",
          signals: { hooks: [], event_handlers: [], browser_globals: [], dynamic_ssr_false: false },
          violations: ["unnecessary_use_client"],
        },
      ],
      counts: {
        total: 2,
        server: 1,
        client_explicit: 1,
        client_inferred: 0,
        ambiguous: 0,
        unnecessary_use_client: 1,
      },
      parse_failures: [],
      scan_errors: [],
      truncated: false,
      workspaces_scanned: ["/tmp/fake"],
      limitations: ["no transitive client boundary detection via barrel files"],
    };

    const out = formatNextjsComponents(result);
    expect(out).toContain("Total: 2");
    expect(out).toContain("Server: 1");
    expect(out).toContain("Client (explicit): 1");
    expect(out).toContain("unnecessary_use_client");
  });
});

describe("analyze_nextjs_components absorbed into framework_audit", () => {
  it("is no longer a standalone TOOL_DEFINITIONS entry", () => {
    const defs = getToolDefinitions();
    const entry = defs.find((t) => t.name === "analyze_nextjs_components");
    expect(entry).toBeUndefined();
  });
});

describe("formatNextjsRouteMap", () => {
  const sampleResult: NextjsRouteMapResult = {
    routes: [
      {
        url_path: "/",
        file_path: "app/page.tsx",
        router: "app",
        type: "page",
        rendering: "static",
        config: { has_generate_static_params: false },
        has_metadata: true,
        layout_chain: ["app/layout.tsx"],
        middleware_applies: false,
        is_client_component: false,
      },
      {
        url_path: "/api/users",
        file_path: "app/api/users/route.ts",
        router: "app",
        type: "route",
        rendering: "ssr",
        config: { dynamic: "force-dynamic", has_generate_static_params: false },
        has_metadata: false,
        methods: ["GET", "POST"],
        layout_chain: [],
        middleware_applies: true,
        is_client_component: false,
      },
    ],
    conflicts: [],
    middleware: { file: "middleware.ts", matchers: ["/api/:path*"] },
    workspaces_scanned: ["/tmp/fake"],
    scan_errors: [],
    truncated: false,
  };

  it("renders a table with URL, Type, Rendering, Router, Metadata", () => {
    const out = formatNextjsRouteMap(sampleResult);
    expect(out).toContain("URL");
    expect(out).toContain("Type");
    expect(out).toContain("Rendering");
    expect(out).toContain("Router");
    expect(out).toContain("Metadata");
    expect(out).toContain("/api/users");
  });

  it("compact formatter drops per-route details", () => {
    const compact = formatNextjsRouteMapCompact(sampleResult);
    expect(compact.length).toBeLessThan(formatNextjsRouteMap(sampleResult).length);
    expect(compact).toContain("Routes:");
  });

  it("counts formatter is even shorter than compact", () => {
    const counts = formatNextjsRouteMapCounts(sampleResult);
    const compact = formatNextjsRouteMapCompact(sampleResult);
    expect(counts.length).toBeLessThanOrEqual(compact.length);
  });
});

describe("nextjs_route_map tool registration", () => {
  it("is a core tool with category 'analysis'", () => {
    const defs = getToolDefinitions();
    const entry = defs.find((t) => t.name === "nextjs_route_map");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("analysis");
    expect(CORE_TOOL_NAMES.has("nextjs_route_map")).toBe(true);
  });
});

describe("formatNextjsBoundaryAnalyzer", () => {
  const sample = (): NextjsBoundaryResult => ({
    entries: [
      { rank: 1, path: "app/big.tsx", signals: { loc: 200, import_count: 8, dynamic_import_count: 0, third_party_imports: ["react", "lodash"] }, score: 390 },
      { rank: 2, path: "app/medium.tsx", signals: { loc: 100, import_count: 4, dynamic_import_count: 1, third_party_imports: ["react"] }, score: 165 },
      { rank: 3, path: "app/small.tsx", signals: { loc: 30, import_count: 2, dynamic_import_count: 0, third_party_imports: [] }, score: 70 },
    ],
    client_count: 3,
    total_client_loc: 330,
    largest_offender: null,
    workspaces_scanned: ["/tmp/x"],
    parse_failures: [],
    scan_errors: [],
    limitations: ["score is signal-based — no actual bundle bytes estimated"],
  });

  it("renders headers and at least 3 data rows", () => {
    const out = formatNextjsBoundaryAnalyzer(sample());
    expect(out).toContain("Rank");
    expect(out).toContain("Path");
    expect(out).toContain("LOC");
    expect(out).toContain("Imports");
    expect(out).toContain("Score");
    expect(out).toContain("big.tsx");
    expect(out).toContain("medium.tsx");
    expect(out).toContain("small.tsx");
  });
});

describe("nextjs_boundary_analyzer absorbed into framework_audit", () => {
  it("is no longer a standalone TOOL_DEFINITIONS entry", () => {
    const defs = getToolDefinitions();
    const entry = defs.find((t) => t.name === "nextjs_boundary_analyzer");
    expect(entry).toBeUndefined();
  });
});
