import { z, lazySchema, type ToolDefinitionEntry, type ToolCategory } from "./shared.js";
import { nextjsRouteMap, nextjsMetadataAudit, frameworkAudit, dispatchFormatter, type AuditDimension } from "./deps.js";

export const NEXTJS_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Next.js framework tools ---
  { order: 4558, definition: {
    name: "nextjs_route_map",
    category: "analysis",
    searchHint: "nextjs next.js route map app router pages router rendering strategy SSG SSR ISR edge middleware",
    description: "Complete Next.js route map with rendering strategy per route. Enumerates App Router and Pages Router conventions, reads route segment config exports (dynamic/revalidate/runtime), classifies each route as static/ssr/isr/edge/client, detects metadata exports, computes layout chain, and flags hybrid conflicts where the same URL is served by both routers.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      router: z.enum(["app", "pages", "both"]).optional().describe("Which routers to scan (default 'both')"),
      include_metadata: z.boolean().optional().describe("Include metadata export detection (default true)"),
      max_routes: z.number().int().positive().optional().describe("Max routes to process (default 1000)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof nextjsRouteMap>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.router != null) opts.router = args.router as "app" | "pages" | "both";
      if (args.include_metadata != null) opts.include_metadata = args.include_metadata as boolean;
      if (args.max_routes != null) opts.max_routes = args.max_routes as number;
      const result = await nextjsRouteMap(args.repo as string ?? "", opts);
      return dispatchFormatter("nextjs_route_map", result);
    },
  } },
  { order: 4580, definition: {
    name: "nextjs_metadata_audit",
    category: "analysis" as ToolCategory,
    searchHint: "nextjs seo metadata title description og image audit canonical twitter json-ld",
    description: "Audit Next.js page metadata for SEO completeness with per-route scoring. Walks app/page.tsx files, extracts title/description/openGraph/canonical/twitter/JSON-LD via tree-sitter, scores each route 0-100 with a weighted formula, and aggregates a per-grade distribution + top issue list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      max_routes: z.number().int().positive().optional().describe("Max routes to process (default 1000)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof nextjsMetadataAudit>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.max_routes != null) opts.max_routes = args.max_routes as number;
      const result = await nextjsMetadataAudit(args.repo as string ?? "", opts);
      return dispatchFormatter("nextjs_metadata_audit", result);
    },
  } },
  { order: 4598, definition: {
    name: "framework_audit",
    category: "analysis" as ToolCategory,
    searchHint: "nextjs next.js framework audit meta-tool overall score security metadata routes components classifier use client use server hooks server actions auth validation rate limit zod api contract route handler openapi method body schema response client boundary bundle imports loc link integrity broken navigation href router push 404 data flow fetch waterfall cache cookies headers ssr revalidate middleware coverage protected admin matcher",
    description: "Run all Next.js sub-audits (components, routes, metadata, security, api_contract, boundary, links, data_flow, middleware_coverage) and aggregate into a unified weighted overall score with grade. Use as a single first-call for any Next.js project.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace path, e.g. 'apps/web'"),
      tools: z.array(z.string()).optional().describe("Subset of tools to run (default: all 9). Names: components, routes, metadata, security, api_contract, boundary, links, data_flow, middleware_coverage"),
      mode: z.enum(["full", "priority"]).optional().describe("Output mode: 'full' returns per-tool results + aggregated summary; 'priority' returns a single unified top-N actionable findings list sorted by severity × cross-tool occurrences"),
      priority_limit: z.number().int().positive().optional().describe("Max findings in priority mode (default: 20)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof frameworkAudit>[1] = {};
      if (args.workspace != null) opts.workspace = args.workspace as string;
      if (args.tools != null) opts.tools = args.tools as AuditDimension[];
      if (args.mode != null) opts.mode = args.mode as "full" | "priority";
      if (args.priority_limit != null) opts.priority_limit = args.priority_limit as number;
      const result = await frameworkAudit(args.repo as string ?? "", opts);
      return dispatchFormatter("framework_audit", result);
    },
  } },
];
