// ---------------------------------------------------------------------------
// CLI command handlers
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Flags } from "./args.js";
import type { CallNode } from "../types.js";
import type { HttpServerHandle } from "../server.js";
import { getFlag, getBoolFlag, getNumFlag, requireArg, requireFlag, parseCommaSeparated, output, die } from "./args.js";

export type CommandHandler = (args: string[], flags: Flags) => Promise<void>;

// ---------------------------------------------------------------------------
// codesift serve — shared local daemon (one process for all editor windows)
// ---------------------------------------------------------------------------

/** Default daemon port — clients point here via `setup --http`. */
export const DEFAULT_DAEMON_PORT = 7077;

export type DaemonHandle = HttpServerHandle;

/** Lockfile paths for the daemon in a given data dir (~/.codesift). */
export function daemonLockPaths(dataDir: string): { pidPath: string; portPath: string } {
  return { pidPath: join(dataDir, "daemon.pid"), portPath: join(dataDir, "daemon.port") };
}

/**
 * True if a process with `pid` is alive. `process.kill(pid, 0)` sends no signal
 * but performs the permission/existence check: ESRCH = dead, EPERM = alive but
 * owned by another user (still alive).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the current daemon lock, or null if absent/unparseable. */
export function readDaemonLock(dataDir: string): { pid: number; port: number } | null {
  const { pidPath, portPath } = daemonLockPaths(dataDir);
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    const port = parseInt(readFileSync(portPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

/**
 * Acquire the daemon lock and start the shared HTTP server.
 *
 * Refuses if a LIVE daemon already holds the lock (single-instance). A STALE
 * lock (pid no longer alive — kill -9, OOM, crash) is reclaimed so the daemon
 * can always restart; without this, a crashed daemon would wedge the lock and
 * coworkers would fall back to per-window stdio = the original OOM incident.
 *
 * `close()` removes the lockfiles, so a graceful SIGTERM leaves a clean slate.
 */
export async function startDaemon(
  opts: { dataDir?: string; port?: number; host?: string; token?: string } = {},
): Promise<DaemonHandle> {
  const { loadConfig } = await import("../config.js");
  const dataDir = opts.dataDir ?? loadConfig().dataDir;
  const { pidPath, portPath } = daemonLockPaths(dataDir);

  const existing = readDaemonLock(dataDir);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(
      `codesift serve already running (pid ${existing.pid}, port ${existing.port}). Stop it first.`,
    );
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidPath, String(process.pid));

  const { startHttpServer } = await import("../server.js");
  const httpOpts: { port?: number; host?: string; token?: string } = {};
  if (opts.port !== undefined) httpOpts.port = opts.port;
  if (opts.host !== undefined) httpOpts.host = opts.host;
  if (opts.token !== undefined) httpOpts.token = opts.token;
  const handle = await startHttpServer(httpOpts);
  writeFileSync(portPath, String(handle.port));

  const release = (): void => {
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try { unlinkSync(portPath); } catch { /* already gone */ }
  };
  const origClose = handle.close;
  return {
    ...handle,
    close: async () => {
      release();
      await origClose();
    },
  };
}

/**
 * `codesift serve` — boot the shared daemon and stay alive until SIGTERM/SIGINT.
 */
async function handleServe(_args: string[], flags: Flags): Promise<void> {
  const port = getNumFlag(flags, "port") ?? DEFAULT_DAEMON_PORT;
  const host = getFlag(flags, "host");
  let handle: DaemonHandle;
  try {
    handle = await startDaemon({ port, ...(host ? { host } : {}) });
  } catch (e) {
    die(`serve: ${(e as Error).message}`);
    return;
  }
  output(
    { status: "serving", url: handle.url, port: handle.port, pid: process.pid },
    flags,
  );
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "function", "method", "class", "interface", "type", "variable", "constant",
  "field", "enum", "namespace", "module", "section", "metadata",
  "test_suite", "test_case", "test_hook", "default_export", "unknown",
]);

const EXCLUDE_TESTS_QUERY_TYPES: ReadonlySet<string> = new Set(["semantic", "hybrid"]);

// ---------------------------------------------------------------------------
// Index commands
// ---------------------------------------------------------------------------

async function handleIndex(args: string[], flags: Flags): Promise<void> {
  const path = requireArg(args, 0, "path");
  const { indexFolder } = await import("../tools/index-tools.js");

  const result = await indexFolder(path, {
    incremental: getBoolFlag(flags, "incremental"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
    watch: getBoolFlag(flags, "no-watch") === true ? false : undefined,
  });
  output(result, flags);
}

async function handleIndexRepo(args: string[], flags: Flags): Promise<void> {
  const url = requireArg(args, 0, "url");
  const { indexRepo } = await import("../tools/index-tools.js");

  const result = await indexRepo(url, {
    branch: getFlag(flags, "branch"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
  });
  output(result, flags);
}

async function handleRepos(_args: string[], flags: Flags): Promise<void> {
  const { listAllRepos } = await import("../tools/index-tools.js");
  const result = await listAllRepos();
  output(result, flags);
}

async function handleInvalidate(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { invalidateCache } = await import("../tools/index-tools.js");
  const result = await invalidateCache(repo);
  output({ invalidated: result, repo }, flags);
}

/**
 * Delete orphaned per-repo cache artifacts (embeddings/index/meta/bm25/graph)
 * whose hash stem is no longer in the registry. These accumulate from
 * re-indexes (hash changes) and ephemeral/test repos that were indexed then
 * deleted — each leaves multi-GB embedding files behind. Use --dry-run to
 * preview. Regenerable: re-indexing recreates anything still needed.
 */
async function handlePrune(_args: string[], flags: Flags): Promise<void> {
  const { readFileSync, readdirSync, statSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadConfig } = await import("../config.js");
  const dataDir = loadConfig().dataDir;
  const dryRun = getBoolFlag(flags, "dry-run");

  // Live index hashes from the registry — everything else is orphaned cache.
  const live = new Set<string>();
  try {
    const reg = JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf-8")) as {
      repos?: Record<string, { index_path?: string }>;
    };
    for (const v of Object.values(reg.repos ?? {})) {
      const ip = v.index_path;
      if (typeof ip === "string") live.add(ip.split("/").pop()!.replace(".index.json", ""));
    }
  } catch {
    die("prune: cannot read registry.json — aborting so live data is never deleted.");
  }
  // Safety: an empty live set would mark every artifact orphaned. Refuse rather
  // than risk nuking a valid (but momentarily empty-looking) data dir.
  if (live.size === 0) {
    die("prune: registry lists 0 repos — aborting (refusing to treat all artifacts as orphans).");
  }

  const re = /^([0-9a-f]{8,})\.(embeddings\.ndjson(\.tmp.*)?|index\.json|embeddings\.meta.*|bm25\.json|graph\.json)$/;
  let files = 0, bytes = 0, kept = 0;
  for (const name of readdirSync(dataDir)) {
    const m = re.exec(name);
    if (!m) continue;
    if (live.has(m[1]!)) { kept++; continue; }
    const full = join(dataDir, name);
    try {
      bytes += statSync(full).size;
      if (!dryRun) unlinkSync(full);
      files++;
    } catch { /* skip unreadable/already-gone */ }
  }
  output({
    pruned: !dryRun,
    dry_run: dryRun,
    orphan_files: files,
    freed_gb: +(bytes / 1e9).toFixed(2),
    kept_live_artifacts: kept,
    data_dir: dataDir,
  }, flags);
}

type ProcessRow = { pid: number; ppid: number; rssKb: number; command: string };

function listProcesses(): ProcessRow[] {
  const raw = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf-8" });
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4] ?? "",
    });
  }
  return rows;
}

function classifyCleanupTarget(command: string, includeGlobalCodesift: boolean): string | null {
  if (command === "" || command.includes("codesift cleanup-processes")) return null;
  if (command.startsWith("node /Users/") && command.includes("/DEV/codesift-mcp/dist/server.js")) {
    return "legacy-dev-dist-server";
  }
  if (command.includes("npm exec chrome-devtools-mcp") || command === "chrome-devtools-mcp") {
    return "chrome-devtools-mcp";
  }
  if (command.includes("chrome-devtools-mcp/") && command.includes("/watchdog/main.js")) {
    return "chrome-devtools-watchdog";
  }
  if (command.includes("npm exec @sentry/mcp-server")) {
    return "sentry-mcp";
  }
  if (command.includes("npm exec @playwright/mcp")) {
    return "playwright-mcp";
  }
  if (includeGlobalCodesift && command.includes("/.npm-global/bin/codesift-mcp")) {
    return "global-codesift-mcp";
  }
  return null;
}

async function handleCleanupProcesses(_args: string[], flags: Flags): Promise<void> {
  const dryRun = getBoolFlag(flags, "dry-run") === true;
  const includeGlobalCodesift = getBoolFlag(flags, "global-codesift") === true;
  const rows = listProcesses();
  const targets = rows
    .map((row) => ({ ...row, reason: classifyCleanupTarget(row.command, includeGlobalCodesift) }))
    .filter((row): row is ProcessRow & { reason: string } => row.reason !== null);

  const beforeMb = targets.reduce((sum, row) => sum + row.rssKb, 0) / 1024;
  const killed: Array<ProcessRow & { reason: string }> = [];
  const failed: Array<ProcessRow & { reason: string; error: string }> = [];

  if (!dryRun) {
    for (const row of targets) {
      try {
        process.kill(row.pid, "SIGKILL");
        killed.push(row);
      } catch (err) {
        failed.push({ ...row, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const byReason: Record<string, { count: number; rss_mb: number }> = {};
  for (const row of targets) {
    byReason[row.reason] ??= { count: 0, rss_mb: 0 };
    byReason[row.reason]!.count += 1;
    byReason[row.reason]!.rss_mb += row.rssKb / 1024;
  }
  for (const value of Object.values(byReason)) {
    value.rss_mb = Number(value.rss_mb.toFixed(1));
  }

  output({
    dry_run: dryRun,
    include_global_codesift: includeGlobalCodesift,
    matched: targets.length,
    killed: dryRun ? 0 : killed.length,
    failed: failed.length,
    matched_rss_mb: Number(beforeMb.toFixed(1)),
    by_reason: byReason,
    failed_pids: failed.map((row) => ({ pid: row.pid, reason: row.reason, error: row.error })),
  }, flags);
}

async function handleIndexConversations(args: string[], flags: Flags): Promise<void> {
  const projectPath = args[0];
  const { indexConversations } = await import("../tools/conversation-tools.js");

  const result = await indexConversations(projectPath);
  if (!getBoolFlag(flags, "quiet")) {
    output(result, flags);
  }
}

// ---------------------------------------------------------------------------
// Search commands
// ---------------------------------------------------------------------------

async function handleSearch(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchText } = await import("../tools/search-tools.js");

  const result = await searchText(repo, query, {
    file_pattern: getFlag(flags, "file-pattern"),
    regex: getBoolFlag(flags, "regex"),
    context_lines: getNumFlag(flags, "context-lines"),
    max_results: getNumFlag(flags, "max-results"),
    group_by_file: getBoolFlag(flags, "group-by-file"),
  });
  output(result, flags);
}

async function handleSymbols(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchSymbols } = await import("../tools/search-tools.js");
  type SymbolKind = import("../types.js").SymbolKind;

  const kindRaw = getFlag(flags, "kind");
  if (kindRaw !== undefined && !VALID_SYMBOL_KINDS.has(kindRaw)) {
    die(`Invalid --kind: ${kindRaw}. Valid: ${Array.from(VALID_SYMBOL_KINDS).join(", ")}`);
  }

  const includeSource = getBoolFlag(flags, "include-source");
  const explicitTopK = getNumFlag(flags, "top-k");
  // When --include-source is set and no explicit --top-k, default to 5
  // instead of 50 to avoid returning 50 full function bodies
  const topK = explicitTopK ?? (includeSource ? 5 : undefined);

  const result = await searchSymbols(repo, query, {
    kind: kindRaw as SymbolKind | undefined,
    file_pattern: getFlag(flags, "file-pattern"),
    include_source: includeSource,
    top_k: topK,
    source_chars: getNumFlag(flags, "source-chars"),
  });
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Outline commands
// ---------------------------------------------------------------------------

async function handleTree(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getFileTree } = await import("../tools/outline-tools.js");

  const result = await getFileTree(repo, {
    path_prefix: getFlag(flags, "path") ?? args[1],
    name_pattern: getFlag(flags, "name-pattern"),
    depth: getNumFlag(flags, "depth"),
    compact: getBoolFlag(flags, "compact"),
    min_symbols: getNumFlag(flags, "min-symbols"),
  });
  output(result, flags);
}

async function handleOutline(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const file = requireArg(args, 1, "file");
  const { getFileOutline } = await import("../tools/outline-tools.js");

  const result = await getFileOutline(repo, file);
  output(result, flags);
}

async function handleRepoOutline(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getRepoOutline } = await import("../tools/outline-tools.js");

  const result = await getRepoOutline(repo);
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Symbol commands
// ---------------------------------------------------------------------------

async function handleSymbol(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const id = requireArg(args, 1, "id");
  const { getSymbol } = await import("../tools/symbol-tools.js");

  const result = await getSymbol(repo, id);
  if (result === null) {
    die(`Symbol not found: ${id}`);
  }
  output(result.symbol, flags);
}

async function handleSymbolsBatch(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const ids = args.slice(1);
  if (ids.length === 0) {
    die("Missing required argument: <ids...>");
  }
  const { getSymbols } = await import("../tools/symbol-tools.js");

  const result = await getSymbols(repo, ids);
  output(result, flags);
}

async function handleFind(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { findAndShow } = await import("../tools/symbol-tools.js");

  const result = await findAndShow(repo, query, getBoolFlag(flags, "include-refs"));
  if (result === null) {
    die(`No symbol found matching: ${query}`);
  }
  output(result, flags);
}

async function handleRefs(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { findReferences } = await import("../tools/symbol-tools.js");

  const result = await findReferences(repo, name, getFlag(flags, "file-pattern"));

  if (getBoolFlag(flags, "json")) {
    output(result, flags);
  } else {
    // Compact tabular output: file:line:col | context
    for (const ref of result) {
      const loc = `${ref.file}:${ref.line}${ref.col ? `:${ref.col}` : ""}`;
      process.stdout.write(`${loc} | ${ref.context}\n`);
    }
    process.stderr.write(`\n${result.length} references found\n`);
  }
}

// ---------------------------------------------------------------------------
// Graph commands
// ---------------------------------------------------------------------------

function printTraceCompact(root: CallNode): void {
  function printNode(node: CallNode, indent: number): void {
    const prefix = indent === 0 ? "" : "  ".repeat(indent) + "|- ";
    const sym = node.symbol;
    const sig = sym.signature ? ` ${sym.signature}` : "";
    const loc = `${sym.file}:${sym.start_line}`;
    process.stdout.write(`${prefix}${sym.kind} | ${sym.name}${sig} | ${loc}\n`);
    for (const child of node.children) {
      printNode(child, indent + 1);
    }
  }
  printNode(root, 0);

  function countNodes(node: CallNode): number {
    return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
  }
  process.stderr.write(`\n${countNodes(root)} symbols in trace\n`);
}

async function handleTrace(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { traceCallChain } = await import("../tools/graph-tools.js");
  type Direction = import("../types.js").Direction;

  const direction = (getFlag(flags, "direction") ?? "callers") as Direction;
  if (direction !== "callers" && direction !== "callees") {
    die(`Invalid --direction: ${direction}. Must be "callers" or "callees".`);
  }

  const result = await traceCallChain(repo, name, direction, {
    depth: getNumFlag(flags, "depth"),
    include_source: getBoolFlag(flags, "include-source") ?? false,
    include_tests: getBoolFlag(flags, "include-tests") ?? false,
  });

  if (getBoolFlag(flags, "json")) {
    output(result, flags);
  } else {
    printTraceCompact(result);
  }
}

async function handleImpact(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { impactAnalysis } = await import("../tools/impact-tools.js");

  const result = await impactAnalysis(repo, since, {
    depth: getNumFlag(flags, "depth"),
    until: getFlag(flags, "until"),
    include_source: getBoolFlag(flags, "include-source"),
  });
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Context commands
// ---------------------------------------------------------------------------

async function handleContext(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { assembleContext } = await import("../tools/context-tools.js");

  const result = await assembleContext(repo, query, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleKnowledgeMap(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getKnowledgeMap } = await import("../tools/context-tools.js");

  const result = await getKnowledgeMap(repo, getFlag(flags, "focus"), getNumFlag(flags, "depth"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Diff commands
// ---------------------------------------------------------------------------

async function handleDiff(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { diffOutline } = await import("../tools/diff-tools.js");

  const result = await diffOutline(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

async function handleChanged(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { changedSymbols } = await import("../tools/diff-tools.js");

  const result = await changedSymbols(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Retrieval & utility commands
// ---------------------------------------------------------------------------

function parseRetrievalQueries(flags: Flags): Array<{ type: string; [key: string]: unknown }> {
  const queriesRaw = getFlag(flags, "queries");
  if (!queriesRaw) {
    die("Missing required flag: --queries <json>");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(queriesRaw);
  } catch {
    die("Invalid JSON for --queries flag");
  }

  if (!Array.isArray(parsed)) {
    die("--queries must be a JSON array");
  }

  for (const item of parsed) {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).type !== "string") {
      die("Each --queries entry must be an object with a \"type\" string field");
    }
  }

  const queries = parsed as Array<{ type: string; [key: string]: unknown }>;

  // --exclude-tests (default: true) — inject into semantic/hybrid sub-queries
  const excludeTests = getBoolFlag(flags, "exclude-tests") !== false;
  for (const q of queries) {
    if (EXCLUDE_TESTS_QUERY_TYPES.has(q.type) && q["exclude_tests"] === undefined) {
      q["exclude_tests"] = excludeTests;
    }
  }

  return queries;
}

async function handleRetrieve(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const queries = parseRetrievalQueries(flags);
  const { codebaseRetrieval } = await import("../retrieval/codebase-retrieval.js");

  const result = await codebaseRetrieval(repo, queries, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleStats(_args: string[], flags: Flags): Promise<void> {
  const { getUsageStats, formatUsageReport } = await import("../storage/usage-stats.js");
  const stats = await getUsageStats();

  // If --json flag is set (or default), output raw stats; otherwise formatted report
  if (getBoolFlag(flags, "json") === false) {
    const report = formatUsageReport(stats);
    process.stdout.write(report + "\n");
  } else {
    output(stats, flags);
  }
}

async function handleGenerateClaudeMd(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { generateClaudeMd } = await import("../tools/generate-tools.js");

  const result = await generateClaudeMd(repo, getFlag(flags, "output"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Analysis commands
// ---------------------------------------------------------------------------

async function handleComplexity(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { analyzeComplexity } = await import("../tools/complexity-tools.js");

  const result = await analyzeComplexity(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    top_n: getNumFlag(flags, "top-n"),
    min_complexity: getNumFlag(flags, "min-complexity"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}

async function handleDeadCode(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { findDeadCode } = await import("../tools/symbol-tools.js");

  const result = await findDeadCode(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}

async function handleHotspots(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { analyzeHotspots } = await import("../tools/hotspot-tools.js");

  const result = await analyzeHotspots(repo, {
    since_days: getNumFlag(flags, "since-days"),
    top_n: getNumFlag(flags, "top-n"),
    file_pattern: getFlag(flags, "file-pattern"),
  });
  output(result, flags);
}

async function handleCommunities(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { detectCommunities } = await import("../tools/community-tools.js");

  const result = await detectCommunities(
    repo,
    getFlag(flags, "focus"),
    getNumFlag(flags, "resolution"),
    getFlag(flags, "output-format") as "json" | "mermaid" | undefined,
  );
  output(result, flags);
}

async function handlePatterns(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const pattern = requireFlag(flags, "pattern");
  const { searchPatterns } = await import("../tools/pattern-tools.js");

  const result = await searchPatterns(repo, pattern, {
    file_pattern: getFlag(flags, "file-pattern"),
    include_tests: getBoolFlag(flags, "include-tests"),
    max_results: getNumFlag(flags, "max-results"),
  });
  output(result, flags);
}

async function handleSetup(args: string[], flags: Flags): Promise<void> {
  const platform = args[0];
  const { formatSetupLines, SUPPORTED_PLATFORMS } = await import("./setup.js");

  if (!platform) {
    die(`Missing platform. Usage: codesift setup <${SUPPORTED_PLATFORMS.join("|")}|all>`);
    return;
  }

  const hooks = getBoolFlag(flags, "no-hooks")
    ? false
    : (getBoolFlag(flags, "hooks") ?? true);
  const rules = getBoolFlag(flags, "no-rules")
    ? false
    : (getBoolFlag(flags, "rules") ?? true);
  const force = getBoolFlag(flags, "force") ?? false;
  // `--no-git-hooks` is a standalone boolean flag (parseArgs stores "no-git-hooks", not "git-hooks": false).
  const gitHooks = getBoolFlag(flags, "no-git-hooks")
    ? false
    : (getBoolFlag(flags, "git-hooks") ?? hooks);
  // --http points the client at the shared `codesift serve` daemon (one process
  // per machine) instead of spawning a stdio server per editor window.
  const http = getBoolFlag(flags, "http") ?? false;
  const port = getNumFlag(flags, "port");
  const options = { hooks, rules, force, gitHooks, http, ...(port !== undefined ? { port } : {}) };

  /** Global post-commit backlog hook — wired here because `formatSetupLines` stays editor-setup only (see setup/setupAll for programmatic installs). */
  async function emitGlobalGitHooksIfRequested(): Promise<void> {
    if (options.gitHooks === false) return;
    // Match setup(): git hooks accompany editor hooks by default; allow `--git-hooks` without `--hooks`.
    const wantGitHooks = options.hooks || getBoolFlag(flags, "git-hooks") === true;
    if (!wantGitHooks) return;

    const { installGitHooks } = await import("./git-hooks-installer.js");
    const result = await installGitHooks({ force });
    if (result.reason) {
      process.stdout.write(`⚠️ git hooks: ${result.reason}\n`);
      return;
    }
    process.stdout.write(`✓ git post-commit hook → ${result.hooksPath}\n`);
    if (result.hooksPathSkippedReason) {
      process.stdout.write(`  (${result.hooksPathSkippedReason})\n`);
    }
  }

  if (platform === "all") {
    for (const p of SUPPORTED_PLATFORMS) {
      const lines = await formatSetupLines(p, options);
      for (const line of lines) process.stdout.write(line + "\n");
    }
    await emitGlobalGitHooksIfRequested();
    return;
  }

  const lines = await formatSetupLines(platform, options);
  for (const line of lines) process.stdout.write(line + "\n");
  await emitGlobalGitHooksIfRequested();
}

async function handleFindClones(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { findClones } = await import("../tools/clone-tools.js");

  const result = await findClones(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    min_similarity: getNumFlag(flags, "threshold"),
    min_lines: getNumFlag(flags, "min-lines"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Command dispatch map
// ---------------------------------------------------------------------------

export const COMMAND_MAP: Record<string, CommandHandler> = {
  "index": handleIndex,
  "index-repo": handleIndexRepo,
  "repos": handleRepos,
  "invalidate": handleInvalidate,
  "prune": handlePrune,
  "cleanup-processes": handleCleanupProcesses,
  "serve": handleServe,
  "index-conversations": handleIndexConversations,
  "search": handleSearch,
  "symbols": handleSymbols,
  "tree": handleTree,
  "outline": handleOutline,
  "repo-outline": handleRepoOutline,
  "symbol": handleSymbol,
  "symbols-batch": handleSymbolsBatch,
  "find": handleFind,
  "refs": handleRefs,
  "trace": handleTrace,
  "impact": handleImpact,
  "context": handleContext,
  "knowledge-map": handleKnowledgeMap,
  "diff": handleDiff,
  "changed": handleChanged,
  "retrieve": handleRetrieve,
  "stats": handleStats,
  "generate-claude-md": handleGenerateClaudeMd,
  "complexity": handleComplexity,
  "dead-code": handleDeadCode,
  "hotspots": handleHotspots,
  "communities": handleCommunities,
  "patterns": handlePatterns,
  "find-clones": handleFindClones,
  "setup": handleSetup,
  "telemetry": async (args: string[], _flags: Flags) => {
    const { handleTelemetry } = await import("./telemetry-commands.js");
    await handleTelemetry(args);
  },
  "wiki-generate": async (args: string[], flags: Flags) => {
    const { handleWikiGenerate } = await import("./wiki-commands.js");
    await handleWikiGenerate(args, flags);
  },
  "wiki-lint": async (args: string[], flags: Flags) => {
    const { handleWikiLint } = await import("./wiki-commands.js");
    await handleWikiLint(args, flags);
  },
  "journal-init": async (args: string[], flags: Flags) => {
    const { handleJournalInit } = await import("./journal-commands.js");
    await handleJournalInit(args, flags);
  },
  "journal-append": async (args: string[], flags: Flags) => {
    const { handleJournalAppend } = await import("./journal-commands.js");
    await handleJournalAppend(args, flags);
  },
  "journal-refresh-overview": async (args: string[], flags: Flags) => {
    const { handleJournalRefreshOverview } = await import("./journal-commands.js");
    await handleJournalRefreshOverview(args, flags);
  },
  "journal-regenerate": async (args: string[], flags: Flags) => {
    const { handleJournalRegenerate } = await import("./journal-commands.js");
    await handleJournalRegenerate(args, flags);
  },
  "journal-lint": async (args: string[], flags: Flags) => {
    const { handleJournalLint } = await import("./journal-commands.js");
    await handleJournalLint(args, flags);
  },
  "journal-migrate": async (args: string[], flags: Flags) => {
    const { handleJournalMigrate } = await import("./journal-commands.js");
    await handleJournalMigrate(args, flags);
  },
  "journal-stats": async (args: string[], flags: Flags) => {
    const { handleJournalStats } = await import("./journal-commands.js");
    await handleJournalStats(args, flags);
  },
  "precheck-read": async () => {
    const { handlePrecheckRead } = await import("./hooks.js");
    await handlePrecheckRead();
  },
  "precheck-bash": async () => {
    const { handlePrecheckBash } = await import("./hooks.js");
    await handlePrecheckBash();
  },
  "precheck-glob": async () => {
    const { handlePrecheckGlob } = await import("./hooks.js");
    await handlePrecheckGlob();
  },
  "precheck-grep": async () => {
    const { handlePrecheckGrep } = await import("./hooks.js");
    await handlePrecheckGrep();
  },
  "precheck-agent": async () => {
    const { handlePrecheckAgent } = await import("./hooks.js");
    await handlePrecheckAgent();
  },
  "session-start": async () => {
    const { handleSessionStart } = await import("./hooks.js");
    await handleSessionStart();
  },
  "session-gate": async () => {
    const { handleSessionGate } = await import("./hooks.js");
    await handleSessionGate();
  },
  "sentinel-writer": async () => {
    const { handleSentinelWriter } = await import("./hooks.js");
    await handleSentinelWriter();
  },
  "postindex-file": async () => {
    const { handlePostindexFile } = await import("./hooks.js");
    await handlePostindexFile();
  },
  "precompact-snapshot": async () => {
    const { handlePrecompactSnapshot } = await import("./hooks.js");
    await handlePrecompactSnapshot();
  },
};
