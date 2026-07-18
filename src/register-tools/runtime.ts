import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  wrapTool,
  resolveRepoFromCwd,
  trackSequentialCalls,
  INDEX_MUTATING_TOOLS,
  type ToolResponse,
} from "../server-helpers.js";
import { withTimeout, withCache, stableStringify, type CachedHandler, type TimeoutResult } from "../register-tool-groups/handler-wrappers.js";
import { trackUsage, trackToolCall, getSessionId, getLocalHostTag, type UsageEntry } from "../storage/usage-tracker.js";
import { recordCacheHit, scheduleSidecarFlush } from "../storage/session-state.js";
import type { ProjectLanguages } from "../utils/language-detect.js";
import type { ToolDefinition } from "../register-tool-groups/shared.js";
import { TOOL_DEFINITION_MAP } from "./discovery.js";

// ---------------------------------------------------------------------------
// Registered tool handles — populated by registerTools(), used by describe_tools reveal
// ---------------------------------------------------------------------------

const toolHandles = new Map<string, any>();

/** Get a registered tool handle by name (for testing and describe_tools reveal) */
export function getToolHandle(name: string) {
  return toolHandles.get(name);
}

interface RegistrationContext {
  server: Pick<McpServer, "tool">;
  languages: ProjectLanguages;
}

let registrationContext: RegistrationContext | null = null;

export function resetToolRegistrationContext(
  server: Pick<McpServer, "tool">,
  languages: ProjectLanguages,
): void {
  toolHandles.clear();
  enabledFrameworkBundles.clear();
  registrationContext = { server, languages };
}

export function setToolHandle(name: string, handle: unknown): void {
  toolHandles.set(name, handle);
}

function isToolLanguageEnabled(tool: ToolDefinition, languages: ProjectLanguages): boolean {
  if (!tool.requiresLanguage) return true;
  return languages[tool.requiresLanguage];
}

// ---------------------------------------------------------------------------
// Runtime wrappers — composed around the existing wrapTool() bind site.
//   • Universal client-facing timeout (except a long-op allowlist).
//   • Opt-in, index-version-aware response cache (definition.cacheable).
//   • tool_timeout telemetry on the usage log so abandoned work is visible.
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

/**
 * Upper bound on any timeout budget (10 min). setTimeout's delay is a SIGNED
 * 32-bit int: anything above 2_147_483_647 overflows and Node fires the timer
 * after ~1ms (with a TimeoutOverflowWarning) — i.e. an unclamped
 * CODESIFT_TOOL_TIMEOUT_MS=2147483648 (or a fat-fingered per-tool timeoutMs)
 * would make EVERY non-exempt tool return `timed_out` instantly. Clamping both
 * inputs makes that unrepresentable.
 */
const MAX_TOOL_TIMEOUT_MS = 600_000;

/**
 * Legitimately-long operations that must never be cut off by the timeout.
 *
 * Derived from the index-mutating set in server-helpers (index_file /
 * index_folder / index_repo — a clone+index of a remote repo routinely runs for
 * minutes) so the two lists cannot drift apart, plus index_conversations (full
 * conversation-history scan). invalidate_cache is index-mutating but trivially
 * fast, so it keeps the normal timeout. Every entry MUST be a real registered
 * tool name — a typo here silently re-arms the timeout on a long op
 * (tests/tools/register/wrapper-wiring.test.ts pins the names against
 * TOOL_DEFINITION_MAP).
 */
export const TIMEOUT_EXEMPT_TOOLS: ReadonlySet<string> = new Set<string>([
  ...[...INDEX_MUTATING_TOOLS].filter((name) => name !== "invalidate_cache"),
  "index_conversations",
]);

/** Upper bound on distinct memoized responses per cacheable tool. */
const CACHE_MAX_ENTRIES = 128;

/** Registry path honoring the CODESIFT_DATA_DIR override (matches loadConfig). */
function registryPath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "registry.json");
}

/** repo name/root → on-disk index path, cached by registry mtime (hot-path safe). */
let registryIndexPathCache: { path: string; mtimeMs: number; map: Map<string, string> } | null = null;

function repoIndexPaths(): Map<string, string> {
  const path = registryPath();
  try {
    const st = statSync(path);
    if (registryIndexPathCache && registryIndexPathCache.path === path && registryIndexPathCache.mtimeMs === st.mtimeMs) {
      return registryIndexPathCache.map;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      repos?: Record<string, { name?: string; root?: string; index_path?: string }>;
    };
    const map = new Map<string, string>();
    for (const meta of Object.values(parsed.repos ?? {})) {
      if (typeof meta.index_path !== "string") continue;
      if (typeof meta.name === "string") map.set(meta.name, meta.index_path);
      if (typeof meta.root === "string") map.set(meta.root, meta.index_path);
    }
    registryIndexPathCache = { path, mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    return new Map();
  }
}

/** repo name/root → working-tree root, cached by registry mtime (hot-path safe). */
let registryRootPathCache: { path: string; mtimeMs: number; map: Map<string, string> } | null = null;

function repoRoots(): Map<string, string> {
  const path = registryPath();
  try {
    const st = statSync(path);
    if (registryRootPathCache && registryRootPathCache.path === path && registryRootPathCache.mtimeMs === st.mtimeMs) {
      return registryRootPathCache.map;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      repos?: Record<string, { name?: string; root?: string }>;
    };
    const map = new Map<string, string>();
    for (const meta of Object.values(parsed.repos ?? {})) {
      if (typeof meta.root !== "string") continue;
      if (typeof meta.name === "string") map.set(meta.name, meta.root);
      map.set(meta.root, meta.root);
    }
    registryRootPathCache = { path, mtimeMs: st.mtimeMs, map };
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Per-repo index-version token for cache keying. index_file rewrites the repo's
 * {hash}.index.json via saveIncremental (bumps updated_at + re-saves), so the
 * file's mtime and size move — a cheap, synchronous, per-repo signal that
 * changes exactly when the index changes (in- or out-of-process). Returns "" for
 * an unknown/unindexed repo (coarser key — acceptable, there is nothing indexed
 * to go stale). Exported for the wiring spike test.
 */
export function getRepoIndexVersion(repo: string): string {
  if (!repo) return "";
  const indexPath = repoIndexPaths().get(repo);
  if (!indexPath) return "";
  try {
    const st = statSync(indexPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/**
 * Resolve a repo root's git directory. Handles the plain `.git/` directory AND
 * the `.git` FILE form used by worktrees/submodules (`gitdir: <path>`, possibly
 * relative to the root). Returns null when there is no git dir (plain folder) or
 * anything is unreadable — never throws.
 */
function gitDirFor(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (!st.isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf-8"));
    const target = match?.[1]?.trim();
    if (!target) return null;
    return isAbsolute(target) ? target : resolve(root, target);
  } catch {
    return null;
  }
}

/** Files inside the git dir whose (mtime,size) move whenever git state moves. */
const GIT_STATE_FILES = [
  "HEAD",      // branch switch / detached-HEAD move rewrites this file
  "index",     // add / commit / checkout / reset / stash all rewrite the index
  "logs/HEAD", // reflog — appended on every commit, checkout, reset, merge, rebase
] as const;

/**
 * Per-repo git-state token for cache keying. Some cacheable tools read GIT state,
 * not just the code index: audit_scan bundles analyze_hotspots (git churn), and
 * architecture_summary surfaces git-derived entry-point/hotspot data. After a
 * `git commit` or branch checkout the on-disk {hash}.index.json can be UNCHANGED,
 * so the index-version token alone would keep serving STALE pre-commit git
 * metrics for the life of a long-lived (daemon) process. Folding the git-dir
 * state into the cache version makes a commit / branch switch / staged change bump
 * the key → cache miss → fresh compute.
 *
 * Implementation: pure `statSync` on the git dir's HEAD / index / logs/HEAD
 * (~0.1ms each, no subprocess). It deliberately does NOT shell out to git:
 * `execFileSync("git", …)` has no timeout and no maxBuffer, so a stalled git (slow
 * network FS, held index.lock) would block the WHOLE event loop indefinitely, and a
 * repo with many untracked files would blow the default 1MB buffer (ENOBUFS →
 * caught → a dirty tree silently reported clean). `git status` also walks the whole
 * worktree — pathological in a monorepo. The stat token has none of those failure
 * modes and is cheap enough to compute fresh on every call (no memo needed).
 *
 * Trade-off vs the old `git status --porcelain` dirty flag: an UNSTAGED edit no
 * longer bumps this token on its own. That is fine — a source edit that matters to
 * a cacheable tool bumps the INDEX-version token (the file gets re-indexed via
 * index_file / the watcher), and everything git-derived (churn, hotspots, blame)
 * only reflects committed history anyway.
 *
 * Returns `mtimeMs:size` per existing file joined by ",", or "" when the repo is
 * unknown/not a git repo (the same coarse, never-throws contract as
 * getRepoIndexVersion). Exported for the wiring test.
 */
export function getRepoGitVersion(repo: string): string {
  if (!repo) return "";
  const root = repoRoots().get(repo);
  if (!root) return "";
  const gitDir = gitDirFor(root);
  if (!gitDir) return "";
  const parts: string[] = [];
  for (const rel of GIT_STATE_FILES) {
    try {
      const st = statSync(join(gitDir, rel));
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(""); // file absent (e.g. reflog disabled, fresh clone) — tolerate
    }
  }
  return parts.some((p) => p !== "") ? parts.join(",") : "";
}

/**
 * Combined `indexVersion|gitVersion` token for `repo` — the version component of
 * the response-cache key.
 *
 * Computed FRESH on every call, on purpose. It used to be memoized behind a ~2s
 * TTL because the git half spawned two synchronous git subprocesses; that memo is
 * gone with the subprocesses (see getRepoGitVersion). What remains is 4 statSync
 * calls (~0.3ms total), so memoizing would buy nothing and cost correctness: the
 * TTL delayed index invalidation by up to 2s, and index_file runs on a post-edit
 * hook — an agent could get PRE-EDIT analysis back from the cache. Freshness is now
 * instant.
 *
 * Never throws: a degraded/unknown repo yields "" for the affected half.
 * Exported for the wiring test.
 */
export function getRepoVersionToken(repo: string): string {
  try {
    return `${getRepoIndexVersion(repo)}|${getRepoGitVersion(repo)}`;
  } catch {
    return "";
  }
}

/**
 * Effective client-facing timeout for a tool, clamped to MAX_TOOL_TIMEOUT_MS so a
 * value above setTimeout's 32-bit limit can never wrap around into an ~instant
 * timeout. Per-tool `timeoutMs` wins over the env default.
 */
export function toolTimeoutMs(tool: ToolDefinition): number {
  if (typeof tool.timeoutMs === "number" && tool.timeoutMs > 0) {
    return Math.min(tool.timeoutMs, MAX_TOOL_TIMEOUT_MS);
  }
  const env = Number(process.env["CODESIFT_TOOL_TIMEOUT_MS"]);
  return Number.isFinite(env) && env > 0
    ? Math.min(env, MAX_TOOL_TIMEOUT_MS)
    : DEFAULT_TOOL_TIMEOUT_MS;
}

function isTimeoutResult(value: unknown): value is TimeoutResult {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "timed_out";
}

/** The repo a call targets: explicit `repo` arg, else resolved from CWD (as wrapTool does). */
function repoForArgs(args: Record<string, unknown>): string {
  const explicit = args["repo"];
  return typeof explicit === "string" && explicit ? explicit : resolveRepoFromCwd(process.cwd());
}

/**
 * Cache key: tool name + resolved repo + repo version + stable args — or **null**
 * (= do not cache this call at all; see withCache).
 *
 * The version component combines the on-disk index-version AND a git-state token,
 * so a change to EITHER the code index (in- or out-of-process re-index) OR git
 * state (commit / branch switch / staged change) bumps the key → cache miss →
 * fresh compute. Both halves are recomputed on every call (4 statSync, ~0.3ms), so
 * invalidation is instant.
 *
 * Degraded contract: when the INDEX half is empty — repo not in the registry, or
 * the registry/index file is unreadable — the key would carry no version component
 * at all, and the entry could then NEVER be invalidated (it would live for the
 * whole process). Rather than "unknown version = cache forever", such a call is
 * declared uncacheable (null): the handler runs every time. Correctness beats a
 * cache hit on a repo whose freshness we cannot observe.
 */
function cacheKeyFor(toolName: string, args: Record<string, unknown>): string | null {
  const repo = repoForArgs(args);
  const version = getRepoVersionToken(repo);
  const indexVersion = version.split("|")[0] ?? "";
  if (indexVersion === "") return null; // unobservable freshness → never memoize
  return stableStringify([toolName, repo, version, args]);
}

/** Suffix appended to a response served from the outer cache (mirrors wrapTool's inner cache). */
const CACHED_MARKER = "\n⚡ cached";

/** Copy of `res` with the cache marker appended — never mutates the memoized object. */
function withCachedMarker(res: ToolResponse): ToolResponse {
  const [first, ...rest] = res.content;
  if (!first) return res;
  return {
    ...res,
    content: [{ type: "text" as const, text: first.text + CACHED_MARKER }, ...rest],
  };
}

/**
 * Telemetry for an outer-cache HIT. On a hit the base (wrapTool) never runs, so
 * NOTHING would otherwise be recorded — every repeat call to a cacheable tool would
 * vanish from usage_stats / usage_hotspots / the session snapshot, i.e. the
 * optimization would corrupt the very feed used to measure it. Records the same
 * helpers wrapTool's inner cache-hit branch records, plus the usage-log entry so
 * hits stay visible to usage_stats. Never throws (telemetry must not affect the
 * tool path); no double-counting — this runs ONLY when the handler did not.
 */
function recordOuterCacheHit(
  toolName: string,
  args: Record<string, unknown>,
  res: ToolResponse,
): void {
  try {
    const text = res.content[0]?.text ?? "";
    trackSequentialCalls(toolName);
    recordCacheHit(toolName, args);
    scheduleSidecarFlush();
    const trackArgs = typeof args["repo"] === "string" && args["repo"]
      ? args
      : { ...args, repo: repoForArgs(args) };
    trackToolCall(toolName, trackArgs, text, text, 0, {
      sentChars: text.length + CACHED_MARKER.length,
    });
  } catch {
    // Telemetry must never affect the tool path.
  }
}

/** Record a tool_timeout event on the usage log (reuses the usage-tracker append). */
function logToolTimeout(toolName: string, args: Record<string, unknown>, timeoutMs: number): void {
  try {
    const entry: UsageEntry = {
      ts: Date.now(),
      tool: "tool_timeout",
      repo: typeof args["repo"] === "string" ? (args["repo"] as string) : "",
      args_summary: {
        tool: toolName,
        timeout_ms: timeoutMs,
        ...(typeof args["query"] === "string" ? { query: (args["query"] as string).slice(0, 120) } : {}),
      },
      elapsed_ms: timeoutMs,
      result_tokens: 0,
      result_chunks: 0,
      session_id: getSessionId(),
      host: getLocalHostTag(),
    };
    void trackUsage(entry).catch(() => {});
  } catch {
    // Telemetry must never affect the tool path.
  }
}

export function registerToolDefinition(
  server: Pick<McpServer, "tool">,
  tool: ToolDefinition,
  languages: ProjectLanguages,
) {
  const existing = toolHandles.get(tool.name);
  if (existing) return existing;

  const timeoutMs = toolTimeoutMs(tool);

  // Existing bind: wrapTool provides repo-resolve, TTL cache, dedup, telemetry.
  // For cacheable tools, bypass wrapTool's inner (args-only) response cache so the
  // outer index-version-aware withCache below is the SOLE cache. The inner cache is
  // invalidated only by an IN-SESSION index_file; letting it also serve cacheable
  // tools would return stale data after an OUT-OF-PROCESS re-index (watcher / another
  // session / another machine) whose change the outer index-version key already saw.
  const base = (args: Record<string, unknown>): Promise<ToolResponse> =>
    wrapTool(
      tool.name,
      args,
      () => tool.handler(args),
      tool.cacheable === true ? { bypassCache: true } : undefined,
    )();

  // Opt-in memoization INSIDE the timeout: a timeout marker is never cached, and
  // work abandoned by the client-facing timeout still populates the cache.
  const cached: CachedHandler<[Record<string, unknown>], ToolResponse> | null =
    tool.cacheable === true
      ? withCache(
          base,
          (args) => cacheKeyFor(tool.name, args),
          CACHE_MAX_ENTRIES,
          // Never memoize an error response. wrapTool RESOLVES failures as
          // { isError: true } (it does not reject), so withCache's reject-cleanup
          // would never fire and a transient failure would stick in the cache
          // until the index-version changed. Cache only successful results.
          (res) => res.isError !== true,
        )
      : null;

  // A cache HIT skips the base handler entirely — so the hit is what records the
  // telemetry (and marks the response) that the base would have recorded.
  const cacheableBase: (args: Record<string, unknown>) => Promise<ToolResponse> = cached
    ? async (args) => {
        const wasHit = cached.has(args);
        const res = await cached(args);
        if (!wasHit) return res;
        recordOuterCacheHit(tool.name, args, res);
        return withCachedMarker(res);
      }
    : base;

  // Universal timeout except the long-op allowlist.
  const timed: (args: Record<string, unknown>) => Promise<ToolResponse | TimeoutResult> =
    TIMEOUT_EXEMPT_TOOLS.has(tool.name)
      ? cacheableBase
      : withTimeout(cacheableBase, timeoutMs, tool.name);

  const handle = server.tool(
    tool.name,
    tool.description,
    tool.schema,
    async (args): Promise<ToolResponse> => {
      const callArgs = args as Record<string, unknown>;
      // Snapshot the args BEFORE the call: wrapTool's resolveRepo MUTATES this
      // object (it fills in `repo` when the client omitted it), and the cache key is
      // computed from the args' content. Keying eviction off the post-call (mutated)
      // object would compute a DIFFERENT key than the one the entry was inserted
      // under, so the eviction below would silently miss on exactly the calls that
      // omit `repo` — the common case.
      const keyArgs: Record<string, unknown> | null = cached ? { ...callArgs } : null;
      const res = await timed(callArgs);
      if (isTimeoutResult(res)) {
        // The abandoned call's promise is still sitting in the cache under its key.
        // If that handler NEVER settles, every later identical call would join the
        // dead promise and time out too — the key would be bricked for the life of
        // the process. Evicting on timeout keeps in-flight coalescing for the normal
        // case while guaranteeing the next call re-invokes.
        if (cached && keyArgs) cached.evict(keyArgs);
        logToolTimeout(tool.name, callArgs, timeoutMs);
        // Return a valid ToolResponse envelope. The bare { status: "timed_out" }
        // marker has no `content` array, so the MCP SDK can reject it as an
        // invalid CallToolResult — turning a clean timeout into a JSON-RPC error.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "timed_out",
                tool: tool.name,
                timeout_ms: timeoutMs,
              }),
            },
          ],
          isError: true,
        };
      }
      return res;
    },
  );

  if (!isToolLanguageEnabled(tool, languages) && typeof handle.disable === "function") {
    handle.disable();
  }

  toolHandles.set(tool.name, handle);
  return handle;
}

function ensureToolRegistered(name: string) {
  const existing = toolHandles.get(name);
  if (existing) return existing;

  const context = registrationContext;
  if (!context) return undefined;

  const tool = TOOL_DEFINITION_MAP.get(name);
  if (!tool) return undefined;

  return registerToolDefinition(context.server, tool, context.languages);
}

export function enableToolByName(name: string): boolean {
  const handle = ensureToolRegistered(name);
  if (!handle) return false;
  const context = registrationContext;
  const tool = TOOL_DEFINITION_MAP.get(name);
  if (context && tool && !isToolLanguageEnabled(tool, context.languages)) {
    return false;
  }
  if (typeof handle.enable === "function") {
    handle.enable();
  }
  return true;
}

/** Framework-specific tool bundles — auto-enabled when the framework is detected in an indexed repo */
const FRAMEWORK_TOOL_BUNDLES: Record<string, string[]> = {
  nestjs: [
    // All NestJS sub-tools absorbed into nest_audit
  ],
};

/** Track which framework bundles have been auto-enabled this session (avoid repeat work) */
const enabledFrameworkBundles = new Set<string>();

/**
 * Enable framework-specific tool bundle — called after indexing when framework is detected.
 * Idempotent: safe to call multiple times. Only enables tools that exist and are currently disabled.
 */
export function enableFrameworkToolBundle(framework: string): string[] {
  if (enabledFrameworkBundles.has(framework)) return [];
  const bundle = FRAMEWORK_TOOL_BUNDLES[framework];
  if (!bundle) return [];

  const enabled: string[] = [];
  for (const name of bundle) {
    if (enableToolByName(name)) {
      enabled.push(name);
    }
  }
  if (enabled.length > 0) enabledFrameworkBundles.add(framework);
  return enabled;
}
