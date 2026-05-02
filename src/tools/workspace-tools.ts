import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CodeIndex, Workspace, WorkspaceBoundaryRule, AffectedResult } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { collectImportEdges, buildWorkspaceAliasResolver } from "../utils/import-graph.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
]);

function workspaceRootRel(ws: Workspace, indexRoot: string): string {
  if (ws.root.startsWith(indexRoot)) {
    return ws.root.slice(indexRoot.length).replace(/^[\\/]+/, "");
  }
  return ws.root;
}

/** Match a workspace selector (name or glob) against a workspace name OR
 *  relative-path id. Supports `*` wildcard and `!` negation. */
function matchWorkspaceSelector(selector: string, candidate: string): boolean {
  const positive = selector.startsWith("!") ? selector.slice(1) : selector;
  if (positive === candidate) return true;
  // Glob → regex: escape, then replace \* with .*
  const escaped = positive.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

function selectorsMatch(selectors: string[], candidate: string): boolean {
  let included = false;
  for (const sel of selectors) {
    if (sel.startsWith("!")) {
      if (matchWorkspaceSelector(sel, candidate)) {
        included = false;
      }
    } else if (matchWorkspaceSelector(sel, candidate)) {
      included = true;
    }
  }
  return included;
}

// ---------------------------------------------------------------------------
// list_workspaces
// ---------------------------------------------------------------------------

export const listWorkspacesSchema = {
  repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
};

export interface ListWorkspacesResult {
  workspaces: Workspace[];
  monorepo_tool: string | null;
}

export async function listWorkspacesHandler(args: { repo?: string }): Promise<ListWorkspacesResult> {
  const index = await getIndexOrEmpty(args.repo);
  if (!index?.workspaces || index.workspaces.length === 0) {
    return { workspaces: [], monorepo_tool: null };
  }
  return {
    workspaces: index.workspaces,
    monorepo_tool: index.workspaces[0]?.manifest_tool ?? null,
  };
}

// ---------------------------------------------------------------------------
// workspace_graph
// ---------------------------------------------------------------------------

export const workspaceGraphSchema = {
  repo: z.string().optional(),
  format: z.enum(["json", "mermaid", "dot"]).optional().describe("Output format (default: json)"),
};

export interface WorkspaceGraphNode {
  id: string;
  name: string | null;
}

export interface WorkspaceGraphEdge {
  from: string;
  to: string;
  kind: "workspace_dep";
}

export interface WorkspaceGraphResult {
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
  /** Format-specific serialized output (when format !== "json"). */
  mermaid?: string;
  dot?: string;
  truncated?: boolean;
}

export async function workspaceGraphHandler(args: {
  repo?: string;
  format?: "json" | "mermaid" | "dot";
}): Promise<WorkspaceGraphResult> {
  const fmt = args.format ?? "json";
  const index = await getIndexOrEmpty(args.repo);
  const workspaces = index?.workspaces ?? [];
  const nodes: WorkspaceGraphNode[] = workspaces.map((w) => ({ id: w.id, name: w.name }));
  const edges: WorkspaceGraphEdge[] = [];
  for (const ws of workspaces) {
    for (const depName of ws.dependencies.workspace) {
      edges.push({ from: ws.id, to: depName, kind: "workspace_dep" });
    }
  }
  const result: WorkspaceGraphResult = { nodes, edges };
  if (fmt === "mermaid") {
    result.mermaid = formatMermaid(nodes, edges);
    if (result.mermaid.length > 100_000) result.truncated = true;
  } else if (fmt === "dot") {
    result.dot = formatDot(nodes, edges);
  }
  return result;
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function formatMermaid(nodes: WorkspaceGraphNode[], edges: WorkspaceGraphEdge[]): string {
  const lines = ["graph TD"];
  for (const n of nodes) {
    const label = n.name ?? n.id;
    lines.push(`  ${safeId(n.id)}["${label.replace(/"/g, '\\"')}"]`);
  }
  for (const e of edges) {
    lines.push(`  ${safeId(e.from)} --> ${safeId(e.to)}`);
  }
  return lines.join("\n");
}

function formatDot(nodes: WorkspaceGraphNode[], edges: WorkspaceGraphEdge[]): string {
  const lines = ["digraph G {"];
  for (const n of nodes) {
    const label = n.name ?? n.id;
    lines.push(`  ${safeId(n.id)} [label="${label.replace(/"/g, '\\"')}"];`);
  }
  for (const e of edges) {
    lines.push(`  ${safeId(e.from)} -> ${safeId(e.to)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// affected_workspaces
// ---------------------------------------------------------------------------

export const affectedWorkspacesSchema = {
  repo: z.string().optional(),
  since: z.string().describe("Git ref to diff against (e.g. HEAD~1, main, <sha>)"),
  include_transitive: z.union([z.boolean(), z.string().transform((s) => s === "true")]).optional(),
};

export async function affectedWorkspacesHandler(args: {
  repo?: string;
  since: string;
  include_transitive?: boolean;
}): Promise<AffectedResult> {
  const includeTransitive = args.include_transitive !== false;
  const empty: AffectedResult = {
    since_ref: args.since,
    changed_files: [],
    affected: [],
    excluded_lockfile_changes: [],
  };

  const index = await getIndexOrEmpty(args.repo);
  if (!index || !index.workspaces || index.workspaces.length === 0) {
    return empty;
  }

  // (1) Git presence pre-check
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: index.root,
      timeout: 5000,
    });
  } catch {
    return { ...empty, error: "not_a_git_repository" };
  }

  // (2) Collect changed files (diff + deletions)
  let allChanged: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", `${args.since}...HEAD`],
      { cwd: index.root, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
    );
    allChanged = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return { ...empty, error: "bad_ref" };
  }

  // (3) Filter lockfiles into excluded_lockfile_changes
  const excluded_lockfile_changes: string[] = [];
  const changed: string[] = [];
  for (const f of allChanged) {
    const base = f.split("/").pop() ?? f;
    if (LOCKFILE_NAMES.has(base)) {
      excluded_lockfile_changes.push(f);
    } else {
      changed.push(f);
    }
  }

  // (4) Map remaining files to current workspaces via longest-prefix
  const wsByPrefix = index.workspaces
    .map((w) => ({ ws: w, rel: workspaceRootRel(w, index.root) }))
    .filter((x) => x.rel.length > 0)
    .sort((a, b) => b.rel.length - a.rel.length);

  const directWorkspaces = new Map<string, string[]>(); // ws.id → list of changed files
  const unmappedFiles: string[] = [];

  for (const file of changed) {
    let matched = false;
    for (const { ws, rel } of wsByPrefix) {
      if (file === rel || file.startsWith(rel + "/")) {
        const list = directWorkspaces.get(ws.id) ?? [];
        list.push(file);
        directWorkspaces.set(ws.id, list);
        matched = true;
        break;
      }
    }
    if (!matched) unmappedFiles.push(file);
  }

  // (5) Reverse-dep walk over the workspace graph (BFS, dedupe)
  // Build reverse-deps: for each workspace, who declares it in dependencies.workspace?
  const reverseDeps = new Map<string, string[]>(); // wsName/id → [consumer ids]
  const idByName = new Map<string, string>();
  for (const ws of index.workspaces) {
    if (ws.name) idByName.set(ws.name, ws.id);
  }
  for (const ws of index.workspaces) {
    for (const depName of ws.dependencies.workspace) {
      const depId = idByName.get(depName) ?? depName;
      const consumers = reverseDeps.get(depId) ?? [];
      consumers.push(ws.id);
      reverseDeps.set(depId, consumers);
    }
  }

  const affected = new Map<string, AffectedResult["affected"][number]>();
  const wsById = new Map(index.workspaces.map((w) => [w.id, w]));

  // Seed direct workspaces
  for (const [id, files] of directWorkspaces) {
    const ws = wsById.get(id);
    affected.set(id, {
      workspace_id: id,
      workspace_name: ws?.name ?? null,
      reason: "direct",
      changed_files: files,
    });
  }

  // BFS transitive (reverse-deps)
  if (includeTransitive) {
    const queue: Array<{ id: string; via: string[] }> = [];
    for (const id of directWorkspaces.keys()) queue.push({ id, via: [id] });
    while (queue.length > 0) {
      const item = queue.shift()!;
      const consumers = reverseDeps.get(item.id) ?? [];
      for (const consumerId of consumers) {
        if (affected.has(consumerId)) continue;
        const ws = wsById.get(consumerId);
        affected.set(consumerId, {
          workspace_id: consumerId,
          workspace_name: ws?.name ?? null,
          reason: "transitive",
          changed_files: [],
          via: item.via,
        });
        queue.push({ id: consumerId, via: [...item.via, consumerId] });
      }
    }
  }

  return {
    since_ref: args.since,
    changed_files: changed,
    affected: [...affected.values()],
    excluded_lockfile_changes,
  };
}

// ---------------------------------------------------------------------------
// workspace_boundaries
// ---------------------------------------------------------------------------

export const workspaceBoundariesSchema = {
  repo: z.string().optional(),
  rules: z
    .array(
      z.object({
        from_workspace: z.string(),
        cannot_import_workspaces: z.array(z.string()),
      }),
    )
    .describe("Workspace boundary rules"),
};

export interface WorkspaceBoundaryViolation {
  from_file: string;
  from_workspace: string;
  to_workspace: string;
  import_target: string;
  rule_matched: WorkspaceBoundaryRule;
}

export interface WorkspaceBoundariesResult {
  violations: WorkspaceBoundaryViolation[];
  warnings: string[];
}

export async function workspaceBoundariesHandler(args: {
  repo?: string;
  rules: WorkspaceBoundaryRule[];
}): Promise<WorkspaceBoundariesResult> {
  const empty: WorkspaceBoundariesResult = { violations: [], warnings: [] };
  const index = await getIndexOrEmpty(args.repo);
  if (!index || !index.workspaces || index.workspaces.length === 0) return empty;

  const wsByPrefix = index.workspaces
    .map((w) => ({ ws: w, rel: workspaceRootRel(w, index.root) }))
    .filter((x) => x.rel.length > 0)
    .sort((a, b) => b.rel.length - a.rel.length);

  // Map any file path to its containing workspace id
  const fileToWs = (file: string): Workspace | null => {
    for (const { ws, rel } of wsByPrefix) {
      if (file === rel || file.startsWith(rel + "/")) return ws;
    }
    return null;
  };

  // Build edges (workspace-aware) and walk every cross-workspace edge regardless
  // of edge kind (relative + alias both count — gemini fix in plan rev 5)
  const edges = await collectImportEdges(index);

  const warnings: string[] = [];
  const ruleSelectorWorkspaces = new Set<string>();
  for (const rule of args.rules) {
    if (rule.from_workspace.includes("*")) continue;
    ruleSelectorWorkspaces.add(rule.from_workspace);
  }
  // Warn for rules referencing workspaces that don't exist
  const knownIds = new Set(index.workspaces.map((w) => w.id));
  const knownNames = new Set(index.workspaces.map((w) => w.name).filter(Boolean) as string[]);
  for (const sel of ruleSelectorWorkspaces) {
    if (!knownIds.has(sel) && !knownNames.has(sel)) {
      warnings.push(`rule references unknown workspace selector: ${sel}`);
    }
  }

  const violations: WorkspaceBoundaryViolation[] = [];

  for (const edge of edges) {
    const fromWs = fileToWs(edge.from);
    const toWs = fileToWs(edge.to);
    if (!fromWs || !toWs) continue;
    if (fromWs.id === toWs.id) continue; // intra-workspace — not a candidate

    const fromCandidate = fromWs.name ?? fromWs.id;
    const fromIdCandidate = fromWs.id;
    const toCandidate = toWs.name ?? toWs.id;
    const toIdCandidate = toWs.id;

    for (const rule of args.rules) {
      const fromMatch =
        matchWorkspaceSelector(rule.from_workspace, fromCandidate) ||
        matchWorkspaceSelector(rule.from_workspace, fromIdCandidate);
      if (!fromMatch) continue;

      // Evaluate cannot_import selectors with negation support
      const matchedAgainstName = selectorsMatch(rule.cannot_import_workspaces, toCandidate);
      const matchedAgainstId = selectorsMatch(rule.cannot_import_workspaces, toIdCandidate);
      if (matchedAgainstName || matchedAgainstId) {
        violations.push({
          from_file: edge.from,
          from_workspace: fromCandidate,
          to_workspace: toCandidate,
          import_target: edge.to,
          rule_matched: rule,
        });
      }
    }
  }

  // Suppress unused-import lint by referencing the alias resolver builder
  // (we re-use it inside collectImportEdges; this assertion documents the link)
  void buildWorkspaceAliasResolver;

  return { violations, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getIndexOrEmpty(repo?: string): Promise<CodeIndex | null> {
  try {
    return await getCodeIndex(repo ?? "", { skipFreshness: true });
  } catch {
    return null;
  }
}
