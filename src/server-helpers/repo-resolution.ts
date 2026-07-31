import { readFileSync, statSync } from "node:fs";
import { join, basename, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { findWorkingTree } from "../utils/worktree.js";
// ---------------------------------------------------------------------------
// Auto-resolve repo from CWD — eliminates mandatory list_repos on session start
// ---------------------------------------------------------------------------

/** Tools that accept a `repo` param and should auto-resolve from CWD */
const TOOLS_WITHOUT_REPO = new Set(["list_repos", "index_folder", "index_repo", "index_conversations", "discover_tools", "describe_tools", "search_conversations", "search_all_conversations", "get_session_snapshot", "get_session_context", "usage_stats", "usage_hotspots", "usage_trace_session", "retros_list", "retros_analyze", "memory_candidate_extract", "optimization_candidates", "pope_insights_push_candidates", "test_tool"]);

/**
 * Default registry location, honoring `CODESIFT_DATA_DIR` like every other
 * consumer (config.ts, the hooks, usage-tracker, telemetry). This used to be a
 * module-level `join(homedir(), ".codesift", …)` constant, which silently
 * ignored the override: a process pointed at an alternate data dir still
 * auto-resolved repos out of the real `~/.codesift/registry.json`. Resolved per
 * call rather than once at import so setting the env var after module load
 * still takes effect.
 */
function defaultRegistryPath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "registry.json");
}
const CONVERSATIONS_PREFIX = join(homedir(), ".claude", "projects") + sep;

interface RegistryRepoMeta {
  name: string;
  root: string;
  symbol_count: number;
  file_count: number;
}

const registryCache = new Map<string, { mtimeMs: number; entries: RegistryRepoMeta[] }>();

/** Read registry synchronously, cached by mtime to avoid disk hits in the hot path. */
export function loadRegistrySync(registryPath: string = defaultRegistryPath()): RegistryRepoMeta[] {
  try {
    // Key the cache on the resolved path. The default is already absolute, so
    // this changes nothing for production callers — it stops a relative path
    // ("registry.json") from keying two different physical files to one entry
    // once the process chdir's, which would serve repo A's registry for repo B.
    const key = resolve(registryPath);
    const st = statSync(key);
    const cached = registryCache.get(key);
    if (cached?.mtimeMs === st.mtimeMs) {
      return cached.entries;
    }
    const parsed = JSON.parse(readFileSync(key, "utf-8")) as { repos?: Record<string, RegistryRepoMeta> };
    const entries = Object.values(parsed.repos ?? {});
    registryCache.set(key, { mtimeMs: st.mtimeMs, entries });
    return entries;
  } catch {
    return [];
  }
}

/** True iff `descendant` is `ancestor` or sits underneath it on a path-segment boundary. */
export function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return descendant.startsWith(a);
}

/**
 * Resolve the repo name for a CWD by consulting the registry.
 *
 * Strategy:
 *  1. Drop chat-history indexes (`~/.claude/projects/...`) — they shadow real
 *     repos when the AI session's CWD matches them as a sibling/ancestor.
 *  2. Drop empty entries (symbol_count=0) — they're stub registrations from
 *     `index_folder` calls that found nothing or got auto-created on cd.
 *  3. Prefer a repo registered for the CWD's own git working tree. A linked
 *     worktree at `<repo>/.worktrees/<task>` has `<repo>` as an ancestor, so
 *     the ancestor rule below would answer with the MAIN checkout's index —
 *     different files, no warning. Measured on ResearchShield: the main tree's
 *     `result.service.ts` was served as 4042 lines while the file in the
 *     agent's worktree was 1415, already refactored. Once the worktree itself
 *     is indexed, this makes it win.
 *  4. Otherwise, from repos whose `root` is an ancestor of `cwd`, pick the
 *     longest match. This handles monorepo subdirs: cwd=/repo/apps/api with
 *     root=/repo registered → resolves to /repo's name. An unindexed worktree
 *     still lands here, which keeps it working — `isDifferentWorkingTree` is
 *     what flags the mismatch to the caller (hint H19).
 *  5. If nothing matches, fall back to `local/<basename(cwd)>` so the tool
 *     surfaces a clear NOT INDEXED error instead of silently using a stale value.
 */
export function resolveRepoFromCwd(cwd: string, registryPath: string = defaultRegistryPath()): string {
  const usable = loadRegistrySync(registryPath).filter(
    (r) =>
      typeof r.root === "string" &&
      !r.root.startsWith(CONVERSATIONS_PREFIX) &&
      r.symbol_count > 0,
  );

  const tree = findWorkingTree(cwd);
  if (tree) {
    const own = usable.find((r) => resolve(r.root) === tree.root);
    if (own) return own.name;
  }

  const candidates = usable.filter((r) => isAncestorOrEqual(r.root, cwd));
  if (candidates.length === 0) {
    return `local/${basename(cwd)}`;
  }
  candidates.sort((a, b) => b.root.length - a.root.length);
  return candidates[0]!.name;
}

/**
 * Root of the registered repo, or null when it is not registered. Used to work
 * out whether an answer describes the caller's own files.
 */
export function repoRootFor(
  repoName: string,
  registryPath: string = defaultRegistryPath(),
): string | null {
  for (const r of loadRegistrySync(registryPath)) {
    if (r.name === repoName && typeof r.root === "string") return r.root;
  }
  return null;
}

/**
 * Canonicalize a repo name to its registered casing via a case-insensitive
 * exact-name match. Agents frequently pass the on-disk basename casing
 * (`local/Rewards-API`) while the repo is registered under its canonical
 * name (`local/rewards-api`). Case-sensitive index getters — getBM25Index /
 * ensureIndexFresh, which look up the registry with exact `getRepo` — then miss
 * and the tool errors. Telemetry (2026-07): find_and_show failed 73/74 calls
 * whose repo had an uppercase letter, and 0/532 lowercase calls.
 *
 * Only rewrites on a case-insensitive *exact* name match. Absolute paths, bare
 * names, and unmatched inputs pass through untouched so the async
 * resolveRegisteredRepoMeta fallbacks (absolute-path / suffix / basename) still
 * apply downstream.
 */
export function canonicalizeRepoName(
  repoName: string,
  registryPath: string = defaultRegistryPath(),
): string {
  if (isAbsolute(repoName)) return repoName; // resolved by path downstream
  const lower = repoName.toLowerCase();
  let ciMatch: string | null = null;
  for (const r of loadRegistrySync(registryPath)) {
    if (typeof r.name !== "string") continue;
    if (r.name === repoName) return repoName; // already canonical — fast path
    if (ciMatch === null && r.name.toLowerCase() === lower) ciMatch = r.name;
  }
  return ciMatch ?? repoName;
}

export function resolveToolRepoArgs(toolName: string, args: Record<string, unknown>): void {
  if (TOOLS_WITHOUT_REPO.has(toolName)) return;
  const provided = args["repo"];
  if (typeof provided === "string" && provided.length > 0) {
    // Normalize caller-supplied casing so downstream case-sensitive getters and
    // the response cache key all agree on the canonical name.
    args["repo"] = canonicalizeRepoName(provided);
    return;
  }
  if (!provided) {
    args["repo"] = resolveRepoFromCwd(process.cwd());
  }
}

/** Test-only: drop the registry cache. */
export function _resetRegistryCacheForTests(): void {
  registryCache.clear();
}
