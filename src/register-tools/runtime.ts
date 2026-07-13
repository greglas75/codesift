import { statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapTool, resolveRepoFromCwd, type ToolResponse } from "../server-helpers.js";
import { withTimeout, withCache, stableStringify, type TimeoutResult } from "../register-tool-groups/handler-wrappers.js";
import { trackUsage, getSessionId, getLocalHostTag, type UsageEntry } from "../storage/usage-tracker.js";
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

/** Legitimately-long operations that must never be cut off by the timeout. */
const TIMEOUT_EXEMPT_TOOLS = new Set([
  "index_folder",
  "index_file",
  "index_conversations",
  "index-conversations",
  "serve",
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
 * Per-repo git-state token for cache keying. Some cacheable tools read GIT state,
 * not just the code index: audit_scan bundles analyze_hotspots (git churn), and
 * architecture_summary surfaces git-derived entry-point/hotspot data. After a
 * `git commit` or branch checkout the on-disk {hash}.index.json can be UNCHANGED,
 * so the index-version token alone would keep serving STALE pre-commit git
 * metrics for the life of a long-lived (daemon) process. Folding HEAD + a dirty
 * flag into the cache version makes a commit / branch-switch / working-tree change
 * bump the key → cache miss → fresh compute.
 *
 * Returns `${headSha}:${dirty ? "d" : "c"}`. Exception-safe: any failure (not a
 * git repo, git missing, unknown/unindexed repo) returns "" — the same coarse
 * fallback contract as getRepoIndexVersion (never throws). The repo → working-tree
 * root is resolved from the same registry the index-path lookup uses. This is the
 * un-memoized source of truth: it spawns git on every call. cacheKeyFor no longer
 * calls it directly — it goes through getRepoVersionToken's short-TTL memo, so the
 * spawn is bounded to ~once per repo per TTL window on the hot path. Exported for
 * the wiring test.
 */
export function getRepoGitVersion(repo: string): string {
  if (!repo) return "";
  const root = repoRoots().get(repo);
  if (!root) return "";
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!head) return "";
    // Non-empty `git status --porcelain` → working tree differs (staged, unstaged,
    // or untracked). A cheap, complete dirty signal; failure is treated as clean
    // ("c") since HEAD already captured the committed state.
    let dirty = false;
    try {
      const porcelain = execFileSync("git", ["-C", root, "status", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      dirty = porcelain.trim().length > 0;
    } catch {
      dirty = false;
    }
    return `${head}:${dirty ? "d" : "c"}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Short-TTL memoization of the per-repo version token.
//
// cacheKeyFor runs on EVERY cacheable-tool invocation — including cache HITS
// (withCache's keyFn runs each call). Computing the token means a statSync
// (getRepoIndexVersion) PLUS two synchronous git subprocesses (getRepoGitVersion:
// `rev-parse HEAD` + `status --porcelain`). Under a long-lived daemon with
// concurrent MCP clients that is a subprocess storm blocking the event loop on the
// exact hot path the cache exists to speed up — a self-DoS.
//
// Fix: memoize the combined `indexVersion|gitVersion` token per repo for a short
// window (TOKEN_TTL_MS). Repeated cacheable calls within the window reuse the token
// (a Map lookup + Date.now() compare — NO git spawn); once the window elapses the
// token is recomputed. This bounds git-state staleness to the TTL (~2s — fine for
// git-derived metrics) and caps git spawns to ~1 per repo per window regardless of
// call volume, WITHOUT changing the correctness contract: a real index or git
// change is still picked up within the TTL (≤ TTL_MS).
// ---------------------------------------------------------------------------

/** Default staleness bound for the memoized per-repo version token (ms). */
const TOKEN_TTL_MS = 2000;
/**
 * Hard cap on the env override. The token TTL is a deliberate freshness/perf
 * trade-off: cached analysis for a repo can reflect an index/git change up to
 * this many ms late (in exchange for not spawning git on every hot-path call).
 * The cap stops a pathological CODESIFT_TOOL_CACHE_TTL_MS (e.g. hours) from
 * making cacheable tools serve badly stale results.
 */
const TOKEN_TTL_MAX_MS = 60_000;

/**
 * Effective TTL: a numeric CODESIFT_TOOL_CACHE_TTL_MS override (incl. 0 = always
 * recompute) wins, clamped to [0, TOKEN_TTL_MAX_MS]; otherwise the default.
 */
function tokenTtlMs(): number {
  const env = Number(process.env["CODESIFT_TOOL_CACHE_TTL_MS"]);
  return Number.isFinite(env) && env >= 0 ? Math.min(env, TOKEN_TTL_MAX_MS) : TOKEN_TTL_MS;
}

/** repo → { token, ts } — short-TTL memo so cacheKeyFor doesn't re-spawn git each call. */
const repoVersionTokenCache = new Map<string, { token: string; ts: number }>();

/**
 * Memoized `indexVersion|gitVersion` token for `repo`. Recomputes (calling the
 * source-of-truth getRepoIndexVersion + getRepoGitVersion) only when the entry is
 * missing or older than the TTL; otherwise returns the cached token. A TTL of 0
 * (env override) forces recompute every call. Exception-safe — never throws: on
 * any failure it falls back to a fresh recompute, and if that also throws, "".
 * Exported for the wiring / TTL tests.
 */
export function getRepoVersionToken(repo: string): string {
  try {
    const now = Date.now();
    const ttl = tokenTtlMs();
    const entry = repoVersionTokenCache.get(repo);
    if (entry && now - entry.ts < ttl) return entry.token;
    const token = `${getRepoIndexVersion(repo)}|${getRepoGitVersion(repo)}`;
    repoVersionTokenCache.set(repo, { token, ts: now });
    return token;
  } catch {
    try {
      return `${getRepoIndexVersion(repo)}|${getRepoGitVersion(repo)}`;
    } catch {
      return "";
    }
  }
}

/** Test-only: drop all memoized version tokens (deterministic TTL-expiry simulation). */
export function _resetRepoVersionTokenCache(): void {
  repoVersionTokenCache.clear();
}

function toolTimeoutMs(tool: ToolDefinition): number {
  if (typeof tool.timeoutMs === "number" && tool.timeoutMs > 0) return tool.timeoutMs;
  const env = Number(process.env["CODESIFT_TOOL_TIMEOUT_MS"]);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TOOL_TIMEOUT_MS;
}

function isTimeoutResult(value: unknown): value is TimeoutResult {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "timed_out";
}

/**
 * Cache key: tool name + resolved repo + repo version + stable args. The version
 * component combines the on-disk index-version AND a git-state token, so a change
 * to EITHER the code index (in- or out-of-process re-index) OR git state (commit /
 * branch-switch / working-tree change) bumps the key → cache miss → fresh compute.
 * The git token closes a freshness gap for cacheable tools that read git state
 * (audit_scan's hotspots, architecture_summary) where the index file is unchanged.
 *
 * The version component is fetched through getRepoVersionToken's short-TTL memo, so
 * this keyFn (which runs on every call, including cache HITS) does NOT re-spawn git
 * per invocation — it costs a Map lookup + Date.now() compare in the common case.
 */
function cacheKeyFor(toolName: string, args: Record<string, unknown>): string {
  const repo = typeof args["repo"] === "string" && args["repo"]
    ? (args["repo"] as string)
    : resolveRepoFromCwd(process.cwd());
  const version = getRepoVersionToken(repo);
  return stableStringify([toolName, repo, version, args]);
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
  const cacheableBase: (args: Record<string, unknown>) => Promise<ToolResponse> =
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
      const res = await timed(args as Record<string, unknown>);
      if (isTimeoutResult(res)) {
        logToolTimeout(tool.name, args as Record<string, unknown>, timeoutMs);
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
