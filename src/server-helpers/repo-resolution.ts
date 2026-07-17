import { readFileSync, statSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
// ---------------------------------------------------------------------------
// Auto-resolve repo from CWD — eliminates mandatory list_repos on session start
// ---------------------------------------------------------------------------

/** Tools that accept a `repo` param and should auto-resolve from CWD */
const TOOLS_WITHOUT_REPO = new Set(["list_repos", "index_folder", "index_repo", "index_conversations", "discover_tools", "describe_tools", "search_conversations", "search_all_conversations", "get_session_snapshot", "get_session_context", "usage_stats", "usage_hotspots", "usage_trace_session", "retros_list", "retros_analyze", "memory_candidate_extract", "optimization_candidates", "pope_insights_push_candidates", "test_tool"]);

const REGISTRY_PATH = join(homedir(), ".codesift", "registry.json");
const CONVERSATIONS_PREFIX = join(homedir(), ".claude", "projects") + sep;

interface RegistryRepoMeta {
  name: string;
  root: string;
  symbol_count: number;
  file_count: number;
}

const registryCache = new Map<string, { mtimeMs: number; entries: RegistryRepoMeta[] }>();

/** Read registry synchronously, cached by mtime to avoid disk hits in the hot path. */
export function loadRegistrySync(registryPath: string = REGISTRY_PATH): RegistryRepoMeta[] {
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
 *  3. From remaining repos whose `root` is an ancestor of `cwd`, pick the
 *     longest match. This handles monorepo subdirs and worktrees correctly:
 *     cwd=/repo/apps/api with root=/repo registered → resolves to /repo's name.
 *  4. If nothing matches, fall back to `local/<basename(cwd)>` so the tool
 *     surfaces a clear NOT INDEXED error instead of silently using a stale value.
 */
export function resolveRepoFromCwd(cwd: string, registryPath: string = REGISTRY_PATH): string {
  const candidates = loadRegistrySync(registryPath).filter(
    (r) =>
      typeof r.root === "string" &&
      !r.root.startsWith(CONVERSATIONS_PREFIX) &&
      r.symbol_count > 0 &&
      isAncestorOrEqual(r.root, cwd),
  );
  if (candidates.length === 0) {
    return `local/${basename(cwd)}`;
  }
  candidates.sort((a, b) => b.root.length - a.root.length);
  return candidates[0]!.name;
}

export function resolveToolRepoArgs(toolName: string, args: Record<string, unknown>): void {
  if (TOOLS_WITHOUT_REPO.has(toolName) || args["repo"]) return;
  args["repo"] = resolveRepoFromCwd(process.cwd());
}

/** Test-only: drop the registry cache. */
export function _resetRegistryCacheForTests(): void {
  registryCache.clear();
}
