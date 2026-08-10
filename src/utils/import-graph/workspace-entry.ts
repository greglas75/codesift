import { readFileSync } from "node:fs";

const DEFAULT_WORKSPACE_ENTRIES = [
  "src/index.ts", "src/index.tsx", "src/index.js",
  "index.ts", "index.tsx", "index.js",
] as const;
const WORKSPACE_SOURCE_EXTENSION = /\.(astro|ts|tsx|js|jsx|mjs|cjs)$/;

interface ParsedPackageJson {
  main?: string;
  module?: string;
  exports?: unknown;
  source?: string;
  types?: string;
}

export function relativeWorkspaceRoot(absPath: string, indexRoot: string): string | null {
  if (!absPath.startsWith(indexRoot)) return null;
  return absPath.slice(indexRoot.length).replace(/^[\\/]+/, "");
}

function readWorkspacePackageJson(absRoot: string): ParsedPackageJson | null {
  try {
    return JSON.parse(readFileSync(`${absRoot}/package.json`, "utf-8")) as ParsedPackageJson;
  } catch {
    return null;
  }
}

function pickConditionalEntry(root: unknown): string | null {
  if (typeof root === "string") return root;
  if (!root || typeof root !== "object") return null;
  const conditional = root as Record<string, unknown>;
  for (const key of ["import", "default", "require"] as const) {
    if (typeof conditional[key] === "string") return conditional[key];
  }
  return null;
}

function pickEntry(pkg: ParsedPackageJson | null): string | null {
  if (!pkg) return null;
  if (typeof pkg.source === "string") return pkg.source;
  if (typeof pkg.module === "string") return pkg.module;
  if (typeof pkg.main === "string") return pkg.main;
  if (!pkg.exports || typeof pkg.exports !== "object") return null;
  return pickConditionalEntry((pkg.exports as Record<string, unknown>)["."]);
}

export function resolveWorkspaceEntry(
  workspaceRoot: string,
  relativeRoot: string,
  fileSet: Set<string>,
  normalizedPaths: Map<string, string>,
): string | null {
  const configuredEntry = pickEntry(readWorkspacePackageJson(workspaceRoot));
  const relativeEntries = configuredEntry
    ? [configuredEntry.replace(/^\.?\/+/, ""), ...DEFAULT_WORKSPACE_ENTRIES]
    : [...DEFAULT_WORKSPACE_ENTRIES];

  for (const entry of relativeEntries) {
    const candidate = relativeRoot ? `${relativeRoot}/${entry}` : entry;
    if (fileSet.has(candidate)) return candidate;
    const normalized = normalizedPaths.get(candidate.replace(WORKSPACE_SOURCE_EXTENSION, ""));
    if (normalized) return normalized;
  }
  return null;
}
