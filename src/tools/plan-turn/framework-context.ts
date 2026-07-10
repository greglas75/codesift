import { basename, relative } from "node:path";
import type { CodeIndex, Workspace } from "../../types.js";

const KNOWN_FRAMEWORK_KEYWORDS: Record<string, string[]> = {
  react: ["react", "jsx", "tsx"],
  nextjs: ["next", "next.js", "nextjs"],
  astro: ["astro"],
  hono: ["hono"],
  php: ["php", "yii", "laravel", "symfony"],
  kotlin: ["kotlin", "compose", "android"],
  python: ["python", "django", "fastapi", "flask"],
};

const MONOREPO_QUERY_TERMS = [
  "monorepo", "workspace", "package", "apps/", "packages/", "affected", "turbo",
];

const MONOREPO_TOOL_NAMES = [
  "list_workspaces", "workspace_graph", "affected_workspaces", "workspace_boundaries",
];

const FRAMEWORK_TOOL_OWNERS: Record<string, string> = {
  astro_actions_audit: "astro",
  astro_analyze_islands: "astro",
  astro_audit: "astro",
  astro_config_analyze: "astro",
  astro_content_collections: "astro",
  astro_db_audit: "astro",
  astro_env_validator: "astro",
  astro_image_audit: "astro",
  astro_middleware: "astro",
  astro_migration_check: "astro",
  astro_route_map: "astro",
  astro_sessions: "astro",
  astro_svg_components: "astro",
  analyze_context_graph: "react",
  analyze_hooks: "react",
  analyze_renders: "react",
  audit_compiler_readiness: "react",
  react_quickstart: "react",
  trace_component_tree: "react",
  analyze_hono_app: "hono",
  analyze_inline_handler: "hono",
  audit_hono_security: "hono",
  detect_hono_modules: "hono",
  extract_api_contract: "hono",
  extract_response_types: "hono",
  find_dead_hono_routes: "hono",
  trace_context_flow: "hono",
  trace_middleware_chain: "hono",
  trace_rpc_types: "hono",
  visualize_hono_routes: "hono",
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectFrameworkMismatch(
  normalizedQuery: string,
  frameworkTools: string[],
): boolean {
  if (frameworkTools.length === 0) return false;
  const detectedTools = frameworkTools.join(" ").toLowerCase();
  for (const [framework, keywords] of Object.entries(KNOWN_FRAMEWORK_KEYWORDS)) {
    for (const keyword of keywords) {
      if (new RegExp(`\\b${escapeRegex(keyword)}\\b`).test(normalizedQuery)
        && !detectedTools.includes(framework)) {
        return true;
      }
    }
  }
  return false;
}

function queryMentionsFramework(query: string, framework: string): boolean {
  const keywords = KNOWN_FRAMEWORK_KEYWORDS[framework] ?? [framework];
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(query));
}

function workspaceQueryTokens(workspace: Workspace, index: CodeIndex): string[] {
  const relativeRoot = relative(index.root, workspace.root).replace(/\\/g, "/");
  const rawTokens = [workspace.id, workspace.name ?? "", relativeRoot, basename(workspace.root)];
  if (workspace.name?.includes("/")) rawTokens.push(workspace.name.split("/").pop() ?? "");
  if (workspace.id.includes("/")) rawTokens.push(workspace.id.split("/").pop() ?? "");
  return [...new Set(rawTokens.map((token) => token.toLowerCase().trim()).filter((token) => token.length > 1))];
}

function queryMentionsWorkspace(query: string, workspace: Workspace, index: CodeIndex): boolean {
  return workspaceQueryTokens(workspace, index).some((token) => {
    if (token.includes("/") || token.includes("@")) return query.includes(token);
    return new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(query);
  });
}

export function filterWorkspaceFrameworkTools(
  baseTools: string[],
  query: string,
  index: CodeIndex,
): string[] {
  const workspaces = index.workspaces ?? [];
  if (workspaces.length === 0) return baseTools;

  const mentionedFrameworks = new Set<string>();
  const workspaceFrameworks = new Set<string>();
  for (const workspace of workspaces) {
    for (const framework of workspace.detected_frameworks) workspaceFrameworks.add(framework);
    if (queryMentionsWorkspace(query, workspace, index)) {
      for (const framework of workspace.detected_frameworks) mentionedFrameworks.add(framework);
    }
  }

  return baseTools.filter((tool) => {
    const framework = FRAMEWORK_TOOL_OWNERS[tool];
    if (!framework || !workspaceFrameworks.has(framework)) return true;
    return queryMentionsFramework(query, framework) || mentionedFrameworks.has(framework);
  });
}

export function augmentFrameworkToolsForMonorepo(
  baseTools: string[],
  query: string,
  index: CodeIndex,
): string[] {
  if (!index.workspaces || index.workspaces.length === 0) return baseTools;
  const normalizedQuery = query.toLowerCase();
  const hasMonorepoTerm = MONOREPO_QUERY_TERMS.some((term) => normalizedQuery.includes(term));
  return hasMonorepoTerm ? [...baseTools, ...MONOREPO_TOOL_NAMES] : baseTools;
}
