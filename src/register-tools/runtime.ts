import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapTool } from "../server-helpers.js";
import type { ProjectLanguages } from "../utils/language-detect.js";
import type { ToolDefinition } from "../register-tool-groups/shared.js";
import { TOOL_DEFINITION_MAP } from "./discovery.js";

// ---------------------------------------------------------------------------
// Registered tool handles — populated by registerTools(), used by describe_tools reveal
// ---------------------------------------------------------------------------

const toolHandles = new Map<string, any>();

/** Get a registered tool handle by name (for testing and describe_tools reveal) */
export function getToolHandle(name: string) {
  return toolHandles.get(name);
}

interface RegistrationContext {
  server: Pick<McpServer, "tool">;
  languages: ProjectLanguages;
}

let registrationContext: RegistrationContext | null = null;

export function resetToolRegistrationContext(
  server: Pick<McpServer, "tool">,
  languages: ProjectLanguages,
): void {
  toolHandles.clear();
  enabledFrameworkBundles.clear();
  registrationContext = { server, languages };
}

export function setToolHandle(name: string, handle: unknown): void {
  toolHandles.set(name, handle);
}

function isToolLanguageEnabled(tool: ToolDefinition, languages: ProjectLanguages): boolean {
  if (!tool.requiresLanguage) return true;
  return languages[tool.requiresLanguage];
}

export function registerToolDefinition(
  server: Pick<McpServer, "tool">,
  tool: ToolDefinition,
  languages: ProjectLanguages,
) {
  const existing = toolHandles.get(tool.name);
  if (existing) return existing;

  const handle = server.tool(
    tool.name,
    tool.description,
    tool.schema,
    async (args) => wrapTool(tool.name, args as Record<string, unknown>, () => tool.handler(args as Record<string, unknown>))(),
  );

  if (!isToolLanguageEnabled(tool, languages) && typeof handle.disable === "function") {
    handle.disable();
  }

  toolHandles.set(tool.name, handle);
  return handle;
}

function ensureToolRegistered(name: string) {
  const existing = toolHandles.get(name);
  if (existing) return existing;

  const context = registrationContext;
  if (!context) return undefined;

  const tool = TOOL_DEFINITION_MAP.get(name);
  if (!tool) return undefined;

  return registerToolDefinition(context.server, tool, context.languages);
}

export function enableToolByName(name: string): boolean {
  const handle = ensureToolRegistered(name);
  if (!handle) return false;
  const context = registrationContext;
  const tool = TOOL_DEFINITION_MAP.get(name);
  if (context && tool && !isToolLanguageEnabled(tool, context.languages)) {
    return false;
  }
  if (typeof handle.enable === "function") {
    handle.enable();
  }
  return true;
}

/** Framework-specific tool bundles — auto-enabled when the framework is detected in an indexed repo */
const FRAMEWORK_TOOL_BUNDLES: Record<string, string[]> = {
  nestjs: [
    // All NestJS sub-tools absorbed into nest_audit
  ],
};

/** Track which framework bundles have been auto-enabled this session (avoid repeat work) */
const enabledFrameworkBundles = new Set<string>();

/**
 * Enable framework-specific tool bundle — called after indexing when framework is detected.
 * Idempotent: safe to call multiple times. Only enables tools that exist and are currently disabled.
 */
export function enableFrameworkToolBundle(framework: string): string[] {
  if (enabledFrameworkBundles.has(framework)) return [];
  const bundle = FRAMEWORK_TOOL_BUNDLES[framework];
  if (!bundle) return [];

  const enabled: string[] = [];
  for (const name of bundle) {
    if (enableToolByName(name)) {
      enabled.push(name);
    }
  }
  if (enabled.length > 0) enabledFrameworkBundles.add(framework);
  return enabled;
}
