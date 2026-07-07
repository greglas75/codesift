import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerShortener, wrapTool } from "./server-helpers.js";
import { detectProjectLanguagesSync, type ProjectLanguages } from "./utils/language-detect.js";
import { setRegisterToolRuntime, zBool } from "./register-tool-groups/shared.js";
import { detectAutoLoadToolsCached } from "./register-tools/autoload.js";
import { CORE_TOOL_NAMES, describeTools, discoverTools, getToolDefinitions } from "./register-tools/discovery.js";
import { enableToolByName, registerToolDefinition, resetToolRegistrationContext, setToolHandle } from "./register-tools/runtime.js";
import { formatComplexityCompact, formatComplexityCounts, formatClonesCompact, formatClonesCounts, formatHotspotsCompact, formatHotspotsCounts, formatTraceRouteCompact, formatTraceRouteCounts } from "./formatters-shortening.js";
import { formatNextjsRouteMapCompact, formatNextjsRouteMapCounts, formatNextjsMetadataAuditCompact, formatNextjsMetadataAuditCounts, formatFrameworkAuditCompact, formatFrameworkAuditCounts } from "./formatters-shortening.js";

export type { ToolCategory, ToolDefinition } from "./register-tool-groups/shared.js";
export { OutputSchemas, SYMBOL_TOOLS, buildH11Hint, zNum } from "./register-tool-groups/shared.js";
export { detectAutoLoadTools, detectAutoLoadToolsCached } from "./register-tools/autoload.js";
export {
  ALWAYS_VISIBLE_TOOL_NAMES,
  CORE_TOOL_NAMES,
  describeTools,
  discoverTools,
  extractToolParams,
  getToolDefinition,
  getToolDefinitions,
  resetDescribeToolsCacheForTesting,
} from "./register-tools/discovery.js";
export { enableFrameworkToolBundle, enableToolByName, getToolHandle } from "./register-tools/runtime.js";

setRegisterToolRuntime({ detectAutoLoadToolsCached, enableToolByName });

const zStringArrayJson = () => z.string().transform((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected JSON array of strings" });
    return z.NEVER;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected JSON array of strings" });
    return z.NEVER;
  }
  return parsed;
});

// ---------------------------------------------------------------------------
// Registration loop
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  options?: { deferNonCore?: boolean; projectRoot?: string },
): void {
  const deferNonCore = options?.deferNonCore ?? false;
  const projectRoot = options?.projectRoot ?? process.cwd();

  // Detect which languages the project actually uses — drives language-gated
  // tool registration. Tools with requiresLanguage="python" are only surfaced
  // when .py files exist, same for PHP and Kotlin.
  let languages: ProjectLanguages;
  try {
    languages = detectProjectLanguagesSync(projectRoot);
  } catch {
    // On failure, enable everything — conservative fallback
    languages = {
      python: true, php: true, typescript: true, javascript: true,
      kotlin: true, go: true, rust: true, ruby: true,
    };
  }

  resetToolRegistrationContext(server, languages);

  // Register either the full catalog or only core tools. In deferred mode the
  // remaining tools are registered lazily via describe_tools(reveal=true),
  // plan_turn auto-reveal, or framework auto-load.
  for (const tool of getToolDefinitions()) {
    if (deferNonCore && !CORE_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    registerToolDefinition(server, tool, languages);
  }

  // Always register discover_tools meta-tool
  const discoverHandle = server.tool(
    "discover_tools",
    "Search tool catalog by keyword or category. Returns matching tools with descriptions.",
    {
      query: z.string().describe("Keywords to search for (e.g. 'dead code', 'complexity', 'rename', 'secrets')"),
      category: z.string().optional().describe("Filter by category (e.g. 'analysis', 'lsp', 'architecture')"),
    },
    async (args) => wrapTool("discover_tools", args as Record<string, unknown>, async () => {
      return discoverTools(args.query as string, args.category as string | undefined);
    })(),
  );
  setToolHandle("discover_tools", discoverHandle);

  // Register describe_tools meta-tool — returns full schema for specific tools by name
  const describeHandle = server.tool(
    "describe_tools",
    "Get full schema for specific tools by name. Use after discover_tools to see params before calling.",
    {
      names: z.union([z.array(z.string()), zStringArrayJson()]).describe("Tool names to describe"),
      reveal: zBool().describe("If true, enable tools in ListTools so the LLM can call them"),
    },
    async (args) => wrapTool("describe_tools", args as Record<string, unknown>, async () => {
      const result = describeTools(args.names as string[]);
      if (args.reveal === true) {
        for (const t of result.tools) {
          enableToolByName(t.name);
        }
      }
      return result;
    })(),
  );
  setToolHandle("describe_tools", describeHandle);

  if (deferNonCore) {
    // Auto-enable framework-specific tools when project type is detected at CWD.
    // E.g. composer.json → enable PHP/Yii2 tools automatically.
    detectAutoLoadToolsCached(projectRoot)
      .then((toEnable) => {
        for (const name of toEnable) {
          enableToolByName(name);
        }
        if (toEnable.length > 0) {
          console.error(`[codesift] Auto-loaded ${toEnable.length} framework tools for detected project type: ${toEnable.join(", ")}`);
        }
      })
      .catch(() => {
        // Silently ignore — auto-detection is best-effort
      });
  }

  // Register progressive shorteners for analysis tools with large outputs
  registerShortener("analyze_complexity", { compact: formatComplexityCompact, counts: formatComplexityCounts });
  registerShortener("find_clones", { compact: formatClonesCompact, counts: formatClonesCounts });
  registerShortener("analyze_hotspots", { compact: formatHotspotsCompact, counts: formatHotspotsCounts });
  registerShortener("trace_route", { compact: formatTraceRouteCompact, counts: formatTraceRouteCounts });
  registerShortener("nextjs_route_map", { compact: formatNextjsRouteMapCompact, counts: formatNextjsRouteMapCounts });
  registerShortener("nextjs_metadata_audit", { compact: formatNextjsMetadataAuditCompact, counts: formatNextjsMetadataAuditCounts });
  registerShortener("framework_audit", { compact: formatFrameworkAuditCompact, counts: formatFrameworkAuditCounts });
  registerShortener("get_session_context", {
    compact: (raw: unknown) => {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      try {
        const data = JSON.parse(text);
        return `session:${data.session_id?.slice(0, 8)} calls:${data.call_count} files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return text.slice(0, 500); }
    },
    counts: (raw: unknown) => {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      try {
        const data = JSON.parse(text);
        return `files:${data.explored_files?.count} symbols:${data.explored_symbols?.count} queries:${data.queries?.count} neg:${data.negative_evidence?.count}`;
      } catch { return "parse error"; }
    },
  });
}
