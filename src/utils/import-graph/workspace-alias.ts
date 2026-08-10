import type { CodeIndex, Workspace } from "../../types.js";
import { buildNormalizedPathMap } from "./path-map.js";
import { relativeWorkspaceRoot, resolveWorkspaceEntry } from "./workspace-entry.js";

const INDEX_SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"] as const;
const WORKSPACE_SOURCE_EXTENSION = /\.(astro|ts|tsx|js|jsx|mjs|cjs)$/;

export interface WorkspaceAliasResolver {
  resolve: (importPath: string, importerFile: string) => string | null;
}

export const NULL_RESOLVER: WorkspaceAliasResolver = { resolve: () => null };

interface WorkspaceLookup {
  fileSet: Set<string>;
  normalizedPaths: Map<string, string>;
}

function lookupFile(candidate: string, lookup: WorkspaceLookup): string | null {
  if (lookup.fileSet.has(candidate)) return candidate;
  const normalized = lookup.normalizedPaths.get(candidate.replace(WORKSPACE_SOURCE_EXTENSION, ""));
  if (normalized) return normalized;
  for (const suffix of INDEX_SUFFIXES) {
    const indexedCandidate = candidate + suffix;
    if (lookup.fileSet.has(indexedCandidate)) return indexedCandidate;
  }
  return null;
}

function findOriginatingWorkspace(
  importerFile: string,
  workspacesByPath: Array<{ rel: string; workspace: Workspace }>,
): Workspace | null {
  for (const { rel, workspace } of workspacesByPath) {
    if (rel === "" || importerFile === rel || importerFile.startsWith(rel + "/")) {
      return workspace;
    }
  }
  return null;
}

function resolveWorkspaceSubpath(
  importPath: string,
  rootsByName: Map<string, string>,
  lookup: WorkspaceLookup,
): string | null {
  for (const [workspaceName, workspaceRoot] of rootsByName) {
    if (!importPath.startsWith(workspaceName + "/")) continue;
    const subpath = importPath.slice(workspaceName.length + 1);
    for (const candidate of [`${workspaceRoot}/${subpath}`, `${workspaceRoot}/src/${subpath}`]) {
      const found = lookupFile(candidate, lookup);
      if (found) return found;
    }
  }
  return null;
}

function resolveTsconfigPath(
  importPath: string,
  importerFile: string,
  index: CodeIndex,
  workspacesByPath: Array<{ rel: string; workspace: Workspace }>,
  lookup: WorkspaceLookup,
): string | null {
  const workspace = findOriginatingWorkspace(importerFile, workspacesByPath);
  if (!workspace) return null;
  const workspaceRoot = relativeWorkspaceRoot(workspace.root, index.root) ?? "";
  for (const mapping of workspace.tsconfig_paths) {
    const wildcard = mapping.from_pattern.endsWith("/*");
    const prefix = wildcard ? mapping.from_pattern.slice(0, -1) : mapping.from_pattern;
    if ((wildcard && !importPath.startsWith(prefix)) || (!wildcard && prefix !== importPath)) continue;
    const captured = wildcard ? importPath.slice(prefix.length) : "";
    for (const target of mapping.to_paths) {
      const expanded = wildcard ? target.replaceAll("*", captured) : target;
      for (const candidate of [expanded, ...(workspaceRoot ? [`${workspaceRoot}/${expanded}`] : [])]) {
        const found = lookupFile(candidate, lookup);
        if (found) return found;
      }
    }
  }
  return null;
}

export function buildWorkspaceAliasResolver(index: CodeIndex): WorkspaceAliasResolver {
  if (!index.workspaces || index.workspaces.length === 0) return NULL_RESOLVER;
  const lookup = {
    fileSet: new Set(index.files.map((file) => file.path)),
    normalizedPaths: buildNormalizedPathMap(index),
  };
  const rootsByName = new Map<string, string>();
  const entriesByName = new Map<string, string | null>();
  const workspacesByPath: Array<{ rel: string; workspace: Workspace }> = [];

  for (const workspace of index.workspaces) {
    const rel = relativeWorkspaceRoot(workspace.root, index.root);
    if (rel === null) continue;
    workspacesByPath.push({ rel, workspace });
    if (workspace.name) {
      rootsByName.set(workspace.name, rel);
      entriesByName.set(
        workspace.name,
        resolveWorkspaceEntry(workspace.root, rel, lookup.fileSet, lookup.normalizedPaths),
      );
    }
  }
  workspacesByPath.sort((left, right) => right.rel.length - left.rel.length);

  return {
    resolve: (importPath, importerFile) => {
      const directEntry = entriesByName.get(importPath);
      if (directEntry) return directEntry;
      const subpath = resolveWorkspaceSubpath(importPath, rootsByName, lookup);
      if (subpath) return subpath;
      return resolveTsconfigPath(importPath, importerFile, index, workspacesByPath, lookup);
    },
  };
}
