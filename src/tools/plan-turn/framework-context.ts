import { basename, relative } from "node:path";
import type { CodeIndex, Workspace } from "../../types.js";
import {
  FRAMEWORK_TOOL_OWNERS,
  KNOWN_FRAMEWORK_KEYWORDS,
  MONOREPO_QUERY_TERMS,
  MONOREPO_TOOL_NAMES,
} from "./framework-data.js";

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
  return hasMonorepoTerm ? [...new Set([...baseTools, ...MONOREPO_TOOL_NAMES])] : baseTools;
}
