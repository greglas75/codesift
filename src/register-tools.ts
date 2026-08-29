import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerShortener, wrapTool } from "./server-helpers.js";
import { setHintToolVisibility } from "./server-helpers/response-hints.js";
import { detectProjectLanguagesSync, type ProjectLanguages } from "./utils/language-detect.js";
import type { HookPlatform } from "./cli/platform.js";
import { setRegisterToolRuntime, zBool } from "./register-tool-groups/shared.js";
import { detectAutoLoadToolsCached } from "./register-tools/autoload.js";
import { describeTools, discoverTools, getToolDefinitions, isFrozenToolListHost, resolveVisibleToolNames, setFrozenToolListHost } from "./register-tools/discovery.js";
import { enableToolByName, getRegisteredToolNames, reapplyRevealedTools, registerToolDefinition, resetToolRegistrationContext, setToolHandle } from "./register-tools/runtime.js";
import { formatComplexityCompact, formatComplexityCounts, formatClonesCompact, formatClonesCounts, formatHotspotsCompact, formatHotspotsCounts, formatTraceRouteCompact, formatTraceRouteCounts } from "./formatters-shortening.js";
import { formatNextjsRouteMapCompact, formatNextjsRouteMapCounts, formatNextjsMetadataAuditCompact, formatNextjsMetadataAuditCounts, formatFrameworkAuditCompact, formatFrameworkAuditCounts } from "./formatters-shortening.js";

export type { ToolCategory, ToolDefinition } from "./register-tool-groups/shared.js";
export { OutputSchemas, SYMBOL_TOOLS, buildH11Hint, zNum } from "./register-tool-groups/shared.js";
export { detectAutoLoadTools, detectAutoLoadToolsCached } from "./register-tools/autoload.js";
export {
  ALWAYS_VISIBLE_TOOL_NAMES,
  CORE_TOOL_NAMES,
  FROZEN_LIST_FALLBACK_TOOL_NAMES,
  isFrozenToolListHost,
  isToolHiddenForHost,
  describeTools,
  discoverTools,
  extractToolParams,
  getToolDefinition,
  getToolDefinitions,
  resetDescribeToolsCacheForTesting, resetDeliveredSchemasForTesting,
} from "./register-tools/discovery.js";
export { enableFrameworkToolBundle, enableToolByName, getToolHandle } from "./register-tools/runtime.js";

setRegisterToolRuntime({ detectAutoLoadToolsCached, enableToolByName });

/**
 * Hosts whose callable tool list is fixed once the session starts, so a later
 * `tools/list_changed` never makes a revealed tool callable.
 *
 * Kept as an explicit allowlist rather than a default: an unknown host is
 * assumed to behave like Claude Code (honours the notification), which keeps
 * the default ListTools small.
 */
const FROZEN_TOOL_LIST_PLATFORMS = new Set<HookPlatform>(["codex"]);

/**
 * Decide whether this session must front-load the reveal-dependent tools.
 * `CODESIFT_STATIC_TOOL_LIST=1|0` forces it on/off for hosts we cannot detect.
 */
export function shouldFrontLoadHiddenTools(platform: HookPlatform): boolean {
  const override = process.env["CODESIFT_STATIC_TOOL_LIST"];
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return FROZEN_TOOL_LIST_PLATFORMS.has(platform);
}

/** Exported for tests — resets the frozen-host flag between cases. */
export function setFrozenToolListHostForTesting(value: boolean): void {
  setFrozenToolListHost(value);
}

/**
 * Make the whole applicable tool surface callable before the host's first
 * `tools/list`.
 *
 * Must run inside the `initialized` notification handler: the client sends
 * `notifications/initialized` and only then requests `tools/list`, so enabling
 * here lands in the very first list the host caches. Doing the same work later
 * (what `describe_tools(reveal=true)` does) is exactly the path that fails on
 * these hosts.
 *
 * Everything is enabled, not just FROZEN_LIST_FALLBACK_TOOL_NAMES: on a host
 * that cannot reveal, any tool left disabled is unreachable for the whole
 * session, and the agent has no way to get at it. This is affordable precisely
 * on these hosts — Codex defers MCP tool schemas AND names, surfacing them only
 * through ToolSearch, so the tool names never enter the prompt (verified in the
 * 2026-07-30 session logs: codesift tool names appear only in tool_search_output
 * payloads). `enableToolByName` still refuses tools whose language is absent
 * from the project, so a TypeScript repo does not gain the Python/PHP surface.
 *
 * Idempotent.
 */
export function frontLoadHiddenToolsForFrozenHost(options?: { remember?: boolean }): string[] {
  // `remember: false` is what the HTTP daemon passes. There, one process answers every client on
  // the machine, so recording the front-load at process scope would give Claude Code the full list
  // as a side effect of a Codex session existing — the exact regression 3e1ec6c reverted. On stdio
  // the process IS the session, so remembering costs nothing and stays the default.
  const remember = options?.remember ?? true;
  setFrozenToolListHost(true);
  const enabled: string[] = [];
  for (const definition of getToolDefinitions()) {
    if (enableToolByName(definition.name, remember)) enabled.push(definition.name);
  }
  return enabled;
}

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
  const visibleToolNames = resolveVisibleToolNames();
  for (const tool of getToolDefinitions()) {
    if (deferNonCore && !visibleToolNames.has(tool.name)) {
      continue;
    }
    registerToolDefinition(server, tool, languages);
  }

  // Always register discover_tools meta-tool
  const discoverHandle = server.registerTool(
    "discover_tools",
    {
      description: "Search tool catalog by keyword or category. Returns matching tools with descriptions.",
      inputSchema: {
        query: z.string().describe("Keywords to search for (e.g. 'dead code', 'complexity', 'rename', 'secrets')"),
        category: z.string().optional().describe("Filter by category (e.g. 'analysis', 'lsp', 'architecture')"),
      },
    },
    async (args) => wrapTool("discover_tools", args as Record<string, unknown>, async () => {
      return discoverTools(args.query as string, args.category as string | undefined);
    })(),
  );
  setToolHandle("discover_tools", discoverHandle);

  // Register describe_tools meta-tool — returns full schema for specific tools by name
  const describeHandle = server.registerTool(
    "describe_tools",
    {
      description: "Get full schema for specific tools by name. Use after discover_tools to see params before calling. A schema already returned earlier in the same session comes back as a pointer, not a repeat — pass force=true if the context no longer holds it.",
      inputSchema: {
        names: z.union([z.array(z.string()), zStringArrayJson()]).describe("Tool names to describe"),
        reveal: zBool().describe("If true, enable tools in ListTools so the LLM can call them"),
        force: zBool().describe("Return the full schema even if it was already returned in this session (use after a compaction)"),
      },
    },
    async (args) => wrapTool("describe_tools", args as Record<string, unknown>, async () => {
      const result = describeTools(args.names as string[], { force: args.force === true });
      if (args.reveal !== true) return result;

      const revealed: string[] = [];
      for (const t of result.tools) {
        if (enableToolByName(t.name)) revealed.push(t.name);
      }
      // On hosts that freeze their tool list at session start, enabling a tool
      // now does NOT make it callable — the client never re-reads tools/list.
      // Say so instead of reporting a silent success the agent will act on and
      // then mark its run BLOCKED when the call fails.
      if (isFrozenToolListHost() && revealed.length > 0) {
        return {
          ...result,
          reveal_ineffective: true,
          reveal_note:
            "This host caches its tool list at session start, so reveal does not make these callable now. " +
            "Language-agnostic analysis tools are already visible without reveal; for anything else, use the " +
            "equivalent visible tool (audit_scan, plan_turn) or restart the session.",
        };
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

  // Restore anything already revealed in THIS process. Under stdio this is a no-op on the first
  // call; under the HTTP daemon, which builds a server per request, it is what keeps a revealed
  // tool callable on the request AFTER the one that revealed it.
  reapplyRevealedTools();

  // Tell the hint builder what the agent can actually call. Must run AFTER reapplyRevealedTools:
  // a tool revealed on an earlier request of the HTTP daemon is callable on this one, and a hint
  // naming it is therefore good advice — computing this before the reapply would suppress it.
  setHintToolVisibility(
    new Set(getToolDefinitions().map((t) => t.name)),
    getRegisteredToolNames(),
  );
}
