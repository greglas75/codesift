/**
 * tsconfig-paths.ts — resolves `@/foo` style aliased imports against the nearest
 * `tsconfig.json`, using `get-tsconfig` for `extends`-chain + paths handling.
 *
 * Two-level cache keeps long-running MCP server processes happy:
 *   - `dirToConfigCache`: `${repoRoot}::${importerDir}` → nearest tsconfig.json path
 *     (or null when none found up to repoRoot). Includes repoRoot so the same
 *     importer directory analyzed under different root boundaries does not reuse
 *     a stale tsconfig from another indexing scope.
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.d.ts",
  "/index.js",
  "/index.mts",
  "/index.cts",
  "/index.mjs",
  "/index.cjs",
];

/** Clear both caches. Called at the start of `index_folder`. */
export function clearTsconfigCache(): void {
  configCache.clear();
  dirToConfigCache.clear();
}

/** True when `dir` resolves to `repoRoot` or a subdirectory of it. */
function isDirInsideRepo(repoRootAbs: string, dir: string): boolean {
  const abs = resolve(dir);
  if (abs === repoRootAbs) return true;
  const rel = relative(repoRootAbs, abs);
  return rel !== "" && !isAbsolute(rel) && !rel.startsWith(`..${sep}`) && !rel.startsWith("..");
}

/** True when `resolvedFileAbs` is a file path inside `repoRootAbs` (no `..` escape). */
function isResolvedFileInsideRepo(repoRootAbs: string, resolvedFileAbs: string): boolean {
  const abs = resolve(resolvedFileAbs);
  const rel = relative(repoRootAbs, abs);
  return (
    rel !== "" &&
    !isAbsolute(rel) &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith("..")
  );
}

function dirToConfigCacheKey(importerDir: string, repoRoot: string): string {
  return `${resolve(repoRoot)}::${resolve(importerDir)}`;
}

/** Walk up from `dir` to `repoRoot`, find nearest `tsconfig.json`.
 * Returns absolute path of the config file, or null if none found.
 * Caches every ancestor visited during the walk under the compound `(repoRoot, dir)`
 * key — sibling lookups under the same parent are O(1) after the first hit. */
function findNearestTsconfig(dir: string, repoRoot: string): string | null {
  const cacheKey = dirToConfigCacheKey(dir, repoRoot);
  const cached = dirToConfigCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const repoRootAbs = resolve(repoRoot);
  const visited: string[] = [];
  let cur = resolve(dir);
  while (isDirInsideRepo(repoRootAbs, cur)) {
    visited.push(cur);
    const candidate = join(cur, "tsconfig.json");
    if (existsSync(candidate)) {
      for (const v of visited) {
        dirToConfigCache.set(dirToConfigCacheKey(v, repoRoot), candidate);
      }
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const v of visited) {
    dirToConfigCache.set(dirToConfigCacheKey(v, repoRoot), null);
  }
  return null;
}

/** Parse a tsconfig.json (with `extends` chain) and build a paths matcher.
 * Returns null on parse error. Caches successful parses only — failures are
 * NOT cached so a user fixing a malformed tsconfig.json mid-session does not
 * stay broken until the next full index_folder. */
function loadTsconfig(configPath: string): ResolvedTsconfig | null {
  const cached = configCache.get(configPath);
  if (cached !== undefined) return cached;

  try {
    const result = getTsconfig(configPath);
    if (!result) {
      // Don't cache: the file might appear on a retry.
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
    // Don't cache parse failures — let the next call retry once the user
    // fixes the malformed config.
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
  // Absolute POSIX/Windows specifiers must not join against baseUrl/paths targets
  // (would escape intended repo scope).
  if (isAbsolute(importPath)) return null;

  const repoRootAbs = resolve(repoRoot);
  const importerDir = dirname(resolve(importerFile));
  const configPath = findNearestTsconfig(importerDir, repoRoot);
  if (!configPath) return null;

  const config = loadTsconfig(configPath);
  if (!config) return null;

  const acceptResolved = (hit: string | null): string | null => {
    if (!hit) return null;
    return isResolvedFileInsideRepo(repoRootAbs, hit) ? hit : null;
  };

  // Try paths matcher first (alias mappings).
  if (config.pathsMatcher) {
    const candidates = config.pathsMatcher(importPath);
    for (const candidate of candidates) {
      const accepted = acceptResolved(probeFile(candidate));
      if (accepted) return accepted;
    }
  }

  // Fallback: bare specifier resolved against baseUrl.
  if (config.baseUrl) {
    const candidate = join(config.baseUrl, importPath);
    const accepted = acceptResolved(probeFile(candidate));
    if (accepted) return accepted;
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
