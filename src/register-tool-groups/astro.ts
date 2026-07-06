import { z, lazySchema, type ToolDefinitionEntry, type ToolCategory } from "./shared.js";
import { getCodeIndex, astroAnalyzeIslands, astroHydrationAudit, astroRouteMap, astroActionsAudit, astroAudit, astroConfigAnalyze, astroContentCollections, astroMiddlewareAudit, astroSessionsAudit, astroDbAudit, astroEnvValidator, astroImageAudit, astroSvgComponents, astroMigrationCheck } from "./deps.js";

export const ASTRO_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Astro tools ---
  { order: 4132, definition: {
    name: "astro_analyze_islands",
    category: "analysis",
    searchHint: "astro islands client hydration directives framework",
    description: "Analyze Astro islands (client:* directives) in a repo. Finds all interactive components with hydration directives, lists server islands with fallback status, and optionally generates optimization recommendations.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path_prefix: z.string().optional().describe("Only scan files under this path prefix"),
      include_recommendations: z.boolean().default(true).describe("Include optimization recommendations (default: true)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroAnalyzeIslands>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.path_prefix != null) opts.path_prefix = args.path_prefix as string;
      if (args.include_recommendations != null) opts.include_recommendations = args.include_recommendations as boolean;
      return await astroAnalyzeIslands(opts);
    },
  } },
  { order: 4150, definition: {
    name: "astro_hydration_audit",
    category: "analysis",
    searchHint: "astro hydration audit anti-patterns client load",
    description: "Audit Astro hydration usage for anti-patterns such as client:load on heavy components, missing client directives, or suboptimal hydration strategies. Returns issues grouped by severity with a letter grade.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      severity: z.enum(["all", "warnings", "errors"]).default("all").describe("Filter issues by severity (default: all)"),
      path_prefix: z.string().optional().describe("Only scan files under this path prefix"),
      fail_on: z.enum(["error", "warning", "info"]).optional().describe("Set exit_code gate: 'error' exits 1 on any errors; 'warning' exits 2 on warnings; 'info' exits 2 on info or warnings"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroHydrationAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.severity != null) opts.severity = args.severity as "all" | "warnings" | "errors";
      if (args.path_prefix != null) opts.path_prefix = args.path_prefix as string;
      if (args.fail_on != null) opts.fail_on = args.fail_on as "error" | "warning" | "info";
      return await astroHydrationAudit(opts);
    },
  } },
  { order: 4170, definition: {
    name: "astro_route_map",
    category: "navigation",
    searchHint: "astro routes pages endpoints file-based routing",
    description: "Map all Astro routes (pages + API endpoints) discovered from the file-based routing structure. Returns routes with type, dynamic params, and handler symbols. Supports json/tree/table output formats.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      include_endpoints: z.boolean().default(true).describe("Include API endpoint routes (default: true)"),
      output_format: z.enum(["json", "tree", "table"]).default("json").describe("Output format: json | tree | table (default: json)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroRouteMap>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.include_endpoints != null) opts.include_endpoints = args.include_endpoints as boolean;
      if (args.output_format != null) opts.output_format = args.output_format as "json" | "tree" | "table";
      return await astroRouteMap(opts);
    },
  } },
  { order: 4188, definition: {
    name: "astro_config_analyze",
    category: "analysis",
    searchHint: "astro config integrations adapter output mode",
    description: "Analyze an Astro project's configuration file (astro.config.mjs/ts/js). Extracts output mode (static/server/hybrid), adapter, integrations, site URL, and base path. Identifies dynamic/unresolved config.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string ?? "");
      if (!index) throw new Error("Repository not found — run index_folder first");
      return await astroConfigAnalyze({ project_root: index.root });
    },
  } },
  { order: 4202, definition: {
    name: "astro_actions_audit",
    category: "analysis",
    searchHint: "astro actions defineAction zod refine passthrough multipart file enctype audit",
    description: "Audit Astro Actions (src/actions/index.ts) for 6 known anti-patterns (AA01-AA06): missing handler return, top-level .refine() (Astro issue #11641), .passthrough() usage (issue #11693), File schema without multipart form, server-side invocation via actions.xxx(), and client calls to unknown actions. Returns issues grouped by severity with an A/B/C/D score.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      severity: z.enum(["all", "warnings", "errors"]).default("all").describe("Filter issues by severity (default: all)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof astroActionsAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.severity != null) opts.severity = args.severity as "all" | "warnings" | "errors";
      return await astroActionsAudit(opts);
    },
  } },
  { order: 4218, definition: {
    name: "astro_content_collections",
    category: "analysis",
    searchHint: "astro content collections defineCollection zod schema reference glob loader frontmatter",
    description: "Parse an Astro content collections config (src/content.config.ts or legacy src/content/config.ts), extract each collection's loader + Zod schema fields, build a reference() graph, and optionally validate entry frontmatter against required fields.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      validate_entries: z.boolean().default(true).describe("Validate entry frontmatter against required schema fields (default: true)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string ?? "");
      if (!index) throw new Error("Repository not found — run index_folder first");
      const opts: Parameters<typeof astroContentCollections>[0] = { project_root: index.root };
      if (args.validate_entries != null) opts.validate_entries = args.validate_entries as boolean;
      return await astroContentCollections(opts);
    },
  } },
  { order: 4235, definition: {
    name: "astro_audit",
    category: "analysis",
    searchHint: "astro meta audit full health check score gates recommendations islands hydration routes config actions content migration patterns workspace monorepo",
    description: "One-call Astro project health check: runs all 7 Astro tools + 13 Astro patterns in parallel, returns unified {score, gates, sections, recommendations}. Pass workspace=<name|path> in monorepos to scope to a single workspace.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace name or path. Scopes the audit to that workspace."),
      skip: z.array(z.string()).optional().describe("Sections to skip: config, hydration, routes, actions, content, migration, patterns"),
    })),
    handler: async (args) => {
      const { resolveWorkspaceScope } = await import("../tools/workspace-scope-helper.js");
      const scope = await resolveWorkspaceScope(args.repo as string ?? "", args.workspace as string | undefined, "astro");
      if ("error" in scope) {
        return { error: scope.error, input: scope.input, available: scope.available };
      }
      const opts: Parameters<typeof astroAudit>[0] = {};
      if (args.repo != null) opts.repo = args.repo as string;
      if (args.skip != null) opts.skip = args.skip as string[];
      if (scope.rootPaths.length > 0) {
        (opts as Record<string, unknown>).file_pattern = `${scope.rootPaths[0]}/**`;
      }
      return await astroAudit(opts);
    },
  } },
  // --- Astro 5 sub-tools (Task 12). Discoverable via describe_tools — NOT in CORE. ---
  { order: 4262, definition: {
    name: "astro_middleware",
    category: "analysis",
    searchHint: "astro middleware onRequest sequence guards routes protected auth flows",
    description: "Parses src/middleware.ts (or .js) — detects onRequest exports, sequence(...) ordering, and guard if-blocks lacking redirect/throw/return Response. Issue codes MW00–MW03.",
    schema: lazySchema(() => ({
      project_root: z.string().optional().describe("Absolute path to project root (default: auto-detected)"),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroMiddlewareAudit(opts);
    },
  } },
  { order: 4278, definition: {
    name: "astro_sessions",
    category: "analysis",
    searchHint: "astro sessions experimental session adapter compatibility node vercel cloudflare",
    description: "Astro 5 Sessions API audit. Detects Astro.session.* / context.session.* usage; cross-checks experimental.session config + adapter compatibility. Issue codes SE01–SE04.",
    schema: lazySchema(() => ({
      project_root: z.string().optional(),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroSessionsAudit(opts);
    },
  } },
  { order: 4294, definition: {
    name: "astro_db_audit",
    category: "analysis",
    searchHint: "astro db defineTable schema columns foreign key index n+1 query loop",
    description: "Astro DB audit. Parses db/config.ts defineTable schemas; detects N+1 query patterns (db.select inside loops via AST), missing FK indexes (per-table scoped), reference cycles. Codes DB00–DB04.",
    schema: lazySchema(() => ({
      project_root: z.string().optional(),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroDbAudit(opts);
    },
  } },
  { order: 4310, definition: {
    name: "astro_env_validator",
    category: "analysis",
    searchHint: "astro env envField schema astro:env client server context import.meta.env",
    description: "Astro 5 astro:env validator. Parses env.schema (envField) and cross-checks against import.meta.env + astro:env/{client,server} imports. Codes EV01–EV04.",
    schema: lazySchema(() => ({
      project_root: z.string().optional(),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroEnvValidator(opts);
    },
  } },
  { order: 4326, definition: {
    name: "astro_image_audit",
    category: "analysis",
    searchHint: "astro image img alt accessibility Picture astro:assets getImage optimization",
    description: "Scans .astro pages for image usage: raw <img> vs <Image>/<Picture>, missing/empty alt attributes, getImage() without astro:assets import. Codes IM01–IM04.",
    schema: lazySchema(() => ({
      project_root: z.string().optional(),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroImageAudit(opts);
    },
  } },
  { order: 4342, definition: {
    name: "astro_svg_components",
    category: "analysis",
    searchHint: "astro svg component import legacy ?component native astro 5",
    description: "Detects *.svg?component imports, tracks per-file usage, flags legacy ?component on Astro 5+, surfaces PascalCase tags used without imports. Codes SV01–SV03.",
    schema: lazySchema(() => ({
      project_root: z.string().optional(),
      repo: z.string().optional(),
    })),
    handler: async (args) => {
      const opts: { project_root?: string; repo?: string } = {};
      if (args.project_root != null) opts.project_root = args.project_root as string;
      if (args.repo != null) opts.repo = args.repo as string;
      return await astroSvgComponents(opts);
    },
  } },
  // --- Astro v6 migration check ---
  { order: 4929, definition: {
    name: "astro_migration_check",
    category: "analysis" as ToolCategory,
    searchHint: "astro v6 migration upgrade breaking changes compatibility check AM01 AM10 content collections ViewTransitions",
    description: "Scan an Astro project for v5→v6 breaking changes. Detects 10 issues (AM01–AM10): removed APIs (Astro.glob, emitESMImage), component renames (ViewTransitions→ClientRouter), content collection config changes, Node.js version requirements, Zod 4 deprecations, hybrid output mode, and removed integrations (@astrojs/lit). Returns a migration report with per-issue effort estimates.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      target_version: z.enum(["6"]).optional().describe("Target Astro version (default: '6')"),
    })),
    handler: async (args) => {
      const mcArgs: Parameters<typeof astroMigrationCheck>[0] = {};
      if (args.repo != null) mcArgs.repo = args.repo as string;
      if (args.target_version != null) mcArgs.target_version = args.target_version as "6";
      const result = await astroMigrationCheck(mcArgs);
      const lines: string[] = [];
      lines.push(`ASTRO MIGRATION CHECK: v${result.current_version ?? "unknown"} → v${result.target_version}`);
      lines.push(`Issues: ${result.summary.total_issues} | Estimated: ${result.summary.estimated_migration_hours}`);
      if (Object.keys(result.summary.by_effort).length > 0) {
        const effortStr = Object.entries(result.summary.by_effort)
          .map(([k, v]) => `${v}×${k}`)
          .join(", ");
        lines.push(`Effort: ${effortStr}`);
      }
      if (result.breaking_changes.length === 0) {
        lines.push("\n✓ No v6 breaking changes detected.");
      } else {
        lines.push("");
        for (const issue of result.breaking_changes) {
          const sev = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
          lines.push(`${sev} ${issue.code} [${issue.category}] — ${issue.message}`);
          lines.push(`  effort: ${issue.effort} | files: ${issue.files.slice(0, 3).join(", ")}${issue.files.length > 3 ? ` +${issue.files.length - 3} more` : ""}`);
          if (issue.migration_guide) lines.push(`  guide: ${issue.migration_guide}`);
        }
      }
      return lines.join("\n");
    },
  } },
];
