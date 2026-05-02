import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTsconfig } from "get-tsconfig";
import type {
  Workspace,
  WorkspaceTsconfigPath,
  WorkspaceDependencies,
} from "../types.js";

// Frameworks recognized at workspace package.json level (mirrors project-tools.ts).
const FRAMEWORK_DEPS: Array<[dep: string, name: string]> = [
  ["next", "nextjs"],
  ["nuxt", "nuxt"],
  ["@nestjs/core", "nestjs"],
  ["@remix-run/node", "remix"],
  ["astro", "astro"],
  ["hono", "hono"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["react", "react"],
];

export interface WorkspaceIndex {
  /** Resolved workspaces (root package excluded; only package-role workspaces). */
  workspaces: Workspace[];
  /** Build-orchestrator / package-manager signal at root. */
  manifest_tool: Workspace["manifest_tool"];
  /** Names of duplicate/conflicting workspace packages (informational). */
  duplicate_names?: string[];
}

interface RawPackageInfo {
  dir: string;
  packageJson: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

/** Resolve workspace metadata for a monorepo root.
 *  Returns null on any unrecoverable failure (caller treats as flat-repo).
 *  Uses @manypkg/get-packages for package enumeration; layers manual
 *  turbo.json / nx.json detection for the manifest_tool field. */
export async function resolveWorkspaces(root: string): Promise<WorkspaceIndex | null> {
  let raw: { tool: string; packages: RawPackageInfo[]; rootPackage?: RawPackageInfo } | null = null;
  try {
    const { getPackages } = await import("@manypkg/get-packages");
    const result = await getPackages(root);
    const rootPackage = result.rootPackage
      ? { dir: result.rootPackage.dir, packageJson: result.rootPackage.packageJson as RawPackageInfo["packageJson"] }
      : undefined;
    raw = {
      tool: typeof result.tool === "string" ? result.tool : (result.tool as { type: string }).type,
      packages: result.packages.map((p) => ({
        dir: p.dir,
        packageJson: p.packageJson as RawPackageInfo["packageJson"],
      })),
      ...(rootPackage ? { rootPackage } : {}),
    };
  } catch (err) {
    // @manypkg throws on non-monorepo or malformed config — caller treats null
    // as flat-repo. Existing regex YAML parser in project-tools.ts is the
    // last-resort fallback and is invoked there, not here.
    return null;
  }

  if (!raw || raw.packages.length === 0) {
    return null;
  }

  // @manypkg returns tool="root" when there is no recognized workspace
  // manager — i.e. a flat single-package repo. Treat as non-monorepo.
  if (raw.tool === "root") {
    return null;
  }

  // manifest_tool: layer Turbo / Nx detection on top of @manypkg's tool
  const tool = (raw.tool as Workspace["manifest_tool"]) || "pnpm";
  let manifest_tool: Workspace["manifest_tool"] = tool;
  if (existsSync(join(root, "turbo.json"))) manifest_tool = "turbo";
  else if (existsSync(join(root, "nx.json"))) manifest_tool = "nx";

  // Build workspace name set up-front for dependency classification
  const nameToInfo = new Map<string, RawPackageInfo>();
  const duplicateNames = new Set<string>();
  for (const pkg of raw.packages) {
    const name = pkg.packageJson.name;
    if (!name) continue;
    if (nameToInfo.has(name)) {
      duplicateNames.add(name);
    }
    nameToInfo.set(name, pkg);
  }

  const workspaces: Workspace[] = [];
  for (const pkg of raw.packages) {
    const name = pkg.packageJson.name ?? null;
    const id = name ?? pkg.dir.slice(root.length).replace(/^[\\/]+/, "");

    const allDeps = {
      ...(pkg.packageJson.dependencies ?? {}),
      ...(pkg.packageJson.devDependencies ?? {}),
      ...(pkg.packageJson.peerDependencies ?? {}),
    };
    const dependencies: WorkspaceDependencies = { workspace: [], external: [] };
    for (const dep of Object.keys(allDeps)) {
      if (nameToInfo.has(dep)) dependencies.workspace.push(dep);
      else dependencies.external.push(dep);
    }

    const detected_frameworks: string[] = [];
    for (const [dep, fwName] of FRAMEWORK_DEPS) {
      if (Object.prototype.hasOwnProperty.call(allDeps, dep)) {
        detected_frameworks.push(fwName);
      }
    }

    const tsconfig_paths = readTsconfigPaths(pkg.dir);

    workspaces.push({
      id,
      name,
      root: pkg.dir,
      package_manager_role: "package",
      manifest_tool,
      dependencies,
      tsconfig_paths,
      detected_frameworks,
    });
  }

  return {
    workspaces,
    manifest_tool,
    ...(duplicateNames.size > 0 ? { duplicate_names: [...duplicateNames] } : {}),
  };
}

/** Read tsconfig.json at the workspace root and extract `paths` aliases.
 *  Cached at index time; never read at query time. */
function readTsconfigPaths(workspaceRoot: string): WorkspaceTsconfigPath[] {
  const tsconfigPath = join(workspaceRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return [];
  try {
    const result = getTsconfig(tsconfigPath);
    const paths = result?.config?.compilerOptions?.paths;
    if (!paths || typeof paths !== "object") return [];
    return Object.entries(paths).map(([from_pattern, to_paths]) => ({
      from_pattern,
      to_paths: Array.isArray(to_paths) ? to_paths : [],
    }));
  } catch {
    return [];
  }
}

