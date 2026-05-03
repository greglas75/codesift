/**
 * tsconfig-paths.ts — resolves `@/foo` style aliased imports against the nearest
 * `tsconfig.json`, using `get-tsconfig` for `extends`-chain + paths handling.
 *
 * Two-level cache keeps long-running MCP server processes happy:
 *   - `dirToConfigCache`: directory absolute path → nearest tsconfig.json path
 *     (or null when none found up to repoRoot).
 *   - `configCache`: tsconfig.json absolute path → parsed { matcher, baseUrl }.
 *
 * Both caches are cleared on `clearTsconfigCache()`. The graph builder calls
 * this at the start of every `index_folder` so config edits between runs take
 * effect.
 *
 * IMPORTANT: when probing `TS_EXTENSIONS`, the empty-string entry that handles
 * exact-file aliases (`paths: { "foo": ["src/foo.ts"] }`) MUST gate on
 * `statSync(candidate).isFile()` — `existsSync` returns true for both files
 * and directories, and a directory match would return the dir path, then fail
 * the downstream `normalizedPaths.get(resolved)` lookup (file-only), silently
 * dropping the edge for `@/components/Button` style aliases pointing at a
 * directory with `index.ts`.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getTsconfig, createPathsMatcher } from "get-tsconfig";

interface ResolvedTsconfig {
  pathsMatcher: ((specifier: string) => string[]) | null;
  baseUrl: string | null;
  configPath: string;
}

const configCache = new Map<string, ResolvedTsconfig | null>();
const dirToConfigCache = new Map<string, string | null>();

// Empty string FIRST: probes the raw candidate path so exact-file aliases work.
// `/index.ts` etc. cover directory-as-module aliases.
const TS_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.d.ts",
  "/index.js",
];

/** Clear both caches. Called at the start of `index_folder`. */
export function clearTsconfigCache(): void {
  configCache.clear();
  dirToConfigCache.clear();
}

/** Walk up from `dir` to `repoRoot`, find nearest `tsconfig.json`.
 * Returns absolute path of the config file, or null if none found. */
function findNearestTsconfig(dir: string, repoRoot: string): string | null {
  const cached = dirToConfigCache.get(dir);
  if (cached !== undefined) return cached;

  const repoRootAbs = resolve(repoRoot);
  let cur = resolve(dir);
  while (cur.startsWith(repoRootAbs) || cur === repoRootAbs) {
    const candidate = join(cur, "tsconfig.json");
    if (existsSync(candidate)) {
      dirToConfigCache.set(dir, candidate);
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  dirToConfigCache.set(dir, null);
  return null;
}

/** Parse a tsconfig.json (with `extends` chain) and build a paths matcher.
 * Returns null on parse error. Caches the result. */
function loadTsconfig(configPath: string): ResolvedTsconfig | null {
  const cached = configCache.get(configPath);
  if (cached !== undefined) return cached;

  try {
    const result = getTsconfig(configPath);
    if (!result) {
      configCache.set(configPath, null);
      return null;
    }
    const matcher = createPathsMatcher(result);
    const baseUrlRaw = result.config.compilerOptions?.baseUrl;
    const baseUrl = baseUrlRaw
      ? resolve(dirname(result.path), baseUrlRaw)
      : null;
    const resolved: ResolvedTsconfig = {
      pathsMatcher: matcher,
      baseUrl,
      configPath: result.path,
    };
    configCache.set(configPath, resolved);
    return resolved;
  } catch (err) {
    console.warn(
      `[tsconfig-paths] failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    configCache.set(configPath, null);
    return null;
  }
}

/** Probe candidate path against TS_EXTENSIONS. Returns the first existing FILE
 * (not directory) match, or null. */
function probeFile(candidate: string): string | null {
  for (const ext of TS_EXTENSIONS) {
    const probe = candidate + ext;
    if (!existsSync(probe)) continue;
    // CRITICAL: empty-string probe matches both files and directories.
    // Without this isFile() gate, `@/components/Button` (a directory) resolves
    // to the directory path, then fails downstream normalizedPaths.get lookup.
    try {
      if (statSync(probe).isFile()) return probe;
    } catch {
      // statSync race; treat as not-a-file
    }
  }
  return null;
}

/** Resolve a TS aliased import against the nearest tsconfig.json.
 *
 * @param importerFile  absolute path of the file containing the import
 * @param importPath    raw import specifier (e.g., "@/components/x")
 * @param repoRoot      walk-up termination boundary (absolute path)
 * @returns absolute path of the resolved file, or null when no alias matches
 *          OR no real file exists with any candidate extension. */
export function resolveTsAliasedImport(
  importerFile: string,
  importPath: string,
  repoRoot: string,
): string | null {
  // Relative paths are not aliases — short-circuit.
  if (importPath.startsWith(".")) return null;

  const importerDir = dirname(resolve(importerFile));
  const configPath = findNearestTsconfig(importerDir, repoRoot);
  if (!configPath) return null;

  const config = loadTsconfig(configPath);
  if (!config) return null;

  // Try paths matcher first (alias mappings).
  if (config.pathsMatcher) {
    const candidates = config.pathsMatcher(importPath);
    for (const candidate of candidates) {
      const hit = probeFile(candidate);
      if (hit) return hit;
    }
  }

  // Fallback: bare specifier resolved against baseUrl.
  if (config.baseUrl) {
    const candidate = join(config.baseUrl, importPath);
    const hit = probeFile(candidate);
    if (hit) return hit;
  }

  return null;
}

// Internal helpers exported for testing only.
export const __test = {
  findNearestTsconfig,
  loadTsconfig,
  probeFile,
  TS_EXTENSIONS,
  // Allow tests to assert cache state without exposing it broadly.
  getConfigCacheSize: () => configCache.size,
  getDirCacheSize: () => dirToConfigCache.size,
};
