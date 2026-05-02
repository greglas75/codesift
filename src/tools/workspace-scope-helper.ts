import { getCodeIndex } from "./index-tools.js";
import type { Workspace } from "../types.js";

export interface WorkspaceScopeResolved {
  /** Repo-relative root paths to use as scoping prefix (one entry per resolved workspace). */
  rootPaths: string[];
  /** Resolved workspaces (for diagnostic output by callers). */
  workspaces: Workspace[];
}

export interface WorkspaceScopeError {
  error: "unknown_workspace";
  input: string;
  available: string[];
}

/** Resolve a `workspace=` argument against the active CodeIndex.
 *  - When `workspace` is provided: look up by exact name or id; return
 *    { error: "unknown_workspace" } if not found.
 *  - When `workspace` is omitted AND `framework` is supplied: smart-default
 *    to the workspaces whose `detected_frameworks` includes the framework.
 *    If none, return { rootPaths: [] } (caller falls back to whole-repo scan).
 *  - On flat repo (no index.workspaces): return { rootPaths: [] }. */
export async function resolveWorkspaceScope(
  repo: string,
  workspace: string | undefined,
  framework?: string,
): Promise<WorkspaceScopeResolved | WorkspaceScopeError> {
  let index;
  try {
    index = await getCodeIndex(repo, { skipFreshness: true });
  } catch {
    index = null;
  }
  const workspaces = index?.workspaces;
  if (!workspaces || workspaces.length === 0) {
    return { rootPaths: [], workspaces: [] };
  }

  if (workspace) {
    const ws = workspaces.find((w) => w.name === workspace || w.id === workspace);
    if (!ws) {
      const available = workspaces.map((w) => w.name ?? w.id);
      return { error: "unknown_workspace", input: workspace, available };
    }
    const rel = relRoot(ws.root, index!.root);
    return { rootPaths: rel ? [rel] : [], workspaces: [ws] };
  }

  // Smart-default by framework
  if (framework) {
    const matched = workspaces.filter((w) => w.detected_frameworks.includes(framework));
    if (matched.length > 0) {
      const rootPaths: string[] = [];
      for (const ws of matched) {
        const rel = relRoot(ws.root, index!.root);
        if (rel) rootPaths.push(rel);
      }
      return { rootPaths, workspaces: matched };
    }
  }

  return { rootPaths: [], workspaces: [] };
}

function relRoot(absPath: string, indexRoot: string): string | null {
  if (!absPath.startsWith(indexRoot)) return null;
  return absPath.slice(indexRoot.length).replace(/^[\\/]+/, "");
}
