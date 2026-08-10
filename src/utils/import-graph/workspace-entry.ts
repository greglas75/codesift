import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const DEFAULT_WORKSPACE_ENTRIES = [
  "src/index.ts", "src/index.tsx", "src/index.js",
  "index.ts", "index.tsx", "index.js",
] as const;
const WORKSPACE_SOURCE_EXTENSION = /\.(astro|ts|tsx|js|jsx|mjs|cjs)$/;
const RUNTIME_EXPORT_CONDITIONS = [
  "import", "default", "require", "node",
] as const;

interface ParsedPackageJson {
  main?: string;
  module?: string;
  exports?: unknown;
  source?: string;
  types?: string;
}

export function relativeWorkspaceRoot(absPath: string, indexRoot: string): string | null {
  const rel = relative(indexRoot, absPath);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return null;
  }
  return rel.replaceAll("\\", "/");
}

function readWorkspacePackageJson(absRoot: string): ParsedPackageJson | null {
  try {
    return JSON.parse(readFileSync(`${absRoot}/package.json`, "utf-8")) as ParsedPackageJson;
  } catch {
    return null;
  }
}

function pickConditionalEntry(root: unknown, depth = 0): string | null {
  if (depth > 8 || Array.isArray(root)) return null;
  if (typeof root === "string") return root;
  if (!root || typeof root !== "object") return null;
  const conditional = root as Record<string, unknown>;
  for (const key of RUNTIME_EXPORT_CONDITIONS) {
    const entry = pickConditionalEntry(conditional[key], depth + 1);
    if (entry) return entry;
  }
  return null;
}

function pickEntry(pkg: ParsedPackageJson | null): string | null | undefined {
  if (!pkg) return undefined;
  if (typeof pkg.source === "string") return pkg.source;
  if (typeof pkg.exports === "string") {
    return pkg.exports.trim() ? pkg.exports : null;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    const exportsMap = pkg.exports as Record<string, unknown>;
    const rootExport = exportsMap["."]
      ?? (Object.keys(exportsMap).some((key) => key.startsWith(".")) ? null : exportsMap);
    const exportedEntry = pickConditionalEntry(rootExport);
    if (exportedEntry) return exportedEntry;
    return null;
  }
  if (typeof pkg.module === "string") return pkg.module;
  if (typeof pkg.main === "string") return pkg.main;
  return undefined;
}

export function resolveWorkspaceEntry(
  workspaceRoot: string,
  relativeRoot: string,
  fileSet: Set<string>,
  normalizedPaths: Map<string, string>,
): string | null {
  const configuredEntry = pickEntry(readWorkspacePackageJson(workspaceRoot));
  if (configuredEntry === null) return null;
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
