import { getSessionId } from "./usage-tracker.js";
import { writeFileSync, renameSync, unlinkSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolEntry {
  symbolId: string;
  name: string;
  file: string;
  firstSeen: number;
  lastSeen: number;
  accessCount: number;
}

export interface FileEntry {
  path: string;
  firstSeen: number;
  lastSeen: number;
  accessCount: number;
}

export interface QueryEntry {
  tool: string;
  query: string;
  repo: string;
  ts: number;
  resultCount: number;
}

export interface NegativeEntry {
  tool: string;
  query: string;
  repo: string;
  ts: number;
  stale: boolean;
  filePattern?: string;
}

export interface SessionState {
  sessionId: string;
  startedAt: number;
  callCount: number;
  exploredSymbols: Map<string, SymbolEntry>;
  exploredFiles: Map<string, FileEntry>;
  queries: QueryEntry[];
  negativeEvidence: NegativeEntry[];
  h10Emitted: boolean;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

function createInitialState(): SessionState {
  return {
    sessionId: getSessionId(),
    startedAt: Date.now(),
    callCount: 0,
    exploredSymbols: new Map(),
    exploredFiles: new Map(),
    queries: [],
    negativeEvidence: [],
    h10Emitted: false,
  };
}

let state: SessionState = createInitialState();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Public API — read access
// ---------------------------------------------------------------------------

export function getSessionState(): SessionState {
  return state;
}

export function getCallCount(): number {
  return state.callCount;
}

// ---------------------------------------------------------------------------
// Reset — for test isolation and server-helpers delegation
// ---------------------------------------------------------------------------

export function resetSession(): void {
  state = createInitialState();
  // Clear any pending sidecar flush timer (CQ22)
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Recording — called from wrapTool() on every tool call
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

const MAX_SYMBOLS = 500;
const MAX_FILES = 300;
const MAX_QUERIES = 200;
const MAX_NEGATIVE_EVIDENCE = 300;

function evictLRU<V extends { lastSeen: number }>(map: Map<string, V>, maxSize: number): void {
  while (map.size > maxSize) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of map) {
      if (entry.lastSeen < oldestTime) {
        oldestTime = entry.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey) map.delete(oldestKey);
    else break;
  }
}

function enforceQueryCap(): void {
  while (state.queries.length > MAX_QUERIES) {
    state.queries.shift();
  }
}

function enforceNegativeEvidenceCap(): void {
  while (state.negativeEvidence.length > MAX_NEGATIVE_EVIDENCE) {
    // Evict stale entries first, then oldest
    const staleIdx = state.negativeEvidence.findIndex(e => e.stale);
    if (staleIdx !== -1) {
      state.negativeEvidence.splice(staleIdx, 1);
    } else {
      state.negativeEvidence.shift();
    }
  }
}

/** Search tools that produce negative evidence on zero results */
export const SEARCH_TOOL_SET = new Set([
  "search_text", "search_symbols", "codebase_retrieval",
  "semantic_search", "find_references",
]);

function addSymbol(symbolId: string, name: string, file: string): void {
  const now = Date.now();
  const existing = state.exploredSymbols.get(symbolId);
  if (existing) {
    existing.lastSeen = now;
    existing.accessCount++;
  } else {
    state.exploredSymbols.set(symbolId, {
      symbolId, name, file, firstSeen: now, lastSeen: now, accessCount: 1,
    });
  }
}

function addFile(path: string): void {
  const now = Date.now();
  const existing = state.exploredFiles.get(path);
  if (existing) {
    existing.lastSeen = now;
    existing.accessCount++;
  } else {
    state.exploredFiles.set(path, {
      path, firstSeen: now, lastSeen: now, accessCount: 1,
    });
  }
}

function extractSymbolsFromResult(resultData: unknown): void {
  if (!resultData || typeof resultData !== "object") return;
  const obj = resultData as Record<string, unknown>;

  // search_symbols, get_symbols → symbols array
  if (Array.isArray(obj["symbols"])) {
    for (const sym of obj["symbols"]) {
      if (sym && typeof sym === "object") {
        const s = sym as Record<string, unknown>;
        const id = (s["id"] ?? s["symbolId"] ?? s["symbol_id"]) as string | undefined;
        if (id && typeof id === "string") {
          addSymbol(id, String(s["name"] ?? ""), String(s["file"] ?? ""));
        }
      }
    }
  }

  // get_symbol → single symbol with id field
  if (typeof obj["id"] === "string" && typeof obj["name"] === "string") {
    addSymbol(obj["id"] as string, obj["name"] as string, String(obj["file"] ?? ""));
  }
}

function extractFilesFromResult(resultData: unknown): void {
  if (!resultData || typeof resultData !== "object") return;
  const obj = resultData as Record<string, unknown>;

  // get_file_outline → file field
  if (typeof obj["file"] === "string") {
    addFile(obj["file"] as string);
  }

  // search_text, get_file_tree → files array
  if (Array.isArray(obj["files"])) {
    for (const f of obj["files"]) {
      if (typeof f === "string") addFile(f);
      else if (f && typeof f === "object" && typeof (f as Record<string, unknown>)["path"] === "string") {
        addFile((f as Record<string, unknown>)["path"] as string);
      }
    }
  }
}

export function recordToolCall(
  tool: string,
  args: Record<string, unknown>,
  resultChunks: number,
  resultData: unknown,
): void {
  state.callCount++;
  const now = Date.now();

  // Extract symbols from result
  extractSymbolsFromResult(resultData);

  // Extract files from result
  extractFilesFromResult(resultData);

  // Extract file_path / path from args for single-file tools
  const filePath = (args["file_path"] ?? args["path"]) as string | undefined;
  if (filePath && typeof filePath === "string") {
    addFile(filePath);
  }

  // Append to queries if args.query exists
  const query = args["query"] as string | undefined;
  const repo = (args["repo"] ?? "") as string;
  if (query && typeof query === "string") {
    state.queries.push({ tool, query, repo, ts: now, resultCount: resultChunks });
  }

  // Negative evidence: search tool with zero results (skip error results)
  const isError = resultData !== null && typeof resultData === "object" && "error" in (resultData as Record<string, unknown>);
  if (SEARCH_TOOL_SET.has(tool) && resultChunks === 0 && !isError) {
    const filePattern = args["file_pattern"] as string | undefined;
    const entry: NegativeEntry = {
      tool,
      query: (query ?? "") as string,
      repo,
      ts: now,
      stale: false,
    };
    if (filePattern != null) entry.filePattern = filePattern;
    state.negativeEvidence.push(entry);
    enforceNegativeEvidenceCap();
  }

  // Enforce caps
  evictLRU(state.exploredSymbols, MAX_SYMBOLS);
  evictLRU(state.exploredFiles, MAX_FILES);
  enforceQueryCap();
}

/**
 * Track a cache-hit tool call.
 * Increments callCount but does NOT evaluate negative evidence
 * (no result data available to inspect).
 */
export function recordCacheHit(
  _tool: string,
  _args: Record<string, unknown>,
): void {
  state.callCount++;
}

// ---------------------------------------------------------------------------
// Negative evidence invalidation — called from watcher
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_CHAR_BUDGET = 700;
const STALENESS_TTL_MS = 120_000;

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

export function isStale(entry: NegativeEntry): boolean {
  return entry.stale || (Date.now() - entry.ts > STALENESS_TTL_MS);
}

// ---------------------------------------------------------------------------
// Snapshot — pure function, can be called from CLI hook too
// ---------------------------------------------------------------------------

function truncateList(items: string[], max: number, label: string): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, max);
  const rest = items.length - max;
  const suffix = rest > 0 ? ` +${rest} more` : "";
  return `${label}: ${shown.join(", ")}${suffix}`;
}

export function formatSnapshot(sessionState: SessionState, repo?: string): string {
  const lines: string[] = [];
  const effectiveRepo = repo ?? sessionState.queries[sessionState.queries.length - 1]?.repo ?? "";

  // Tier 1: Header (~15 tokens)
  lines.push(`session:${sessionState.sessionId.slice(0, 8)} calls:${sessionState.callCount} started:${new Date(sessionState.startedAt).toISOString().slice(0, 16)}`);

  // Tier 2: Top 5 files by accessCount
  const files = [...sessionState.exploredFiles.values()]
    .sort((a, b) => b.accessCount - a.accessCount || b.lastSeen - a.lastSeen);
  const fileNames = files.map(f => f.path.split("/").pop() ?? f.path);
  const tier2 = truncateList(fileNames, 5, "FILES");

  // Tier 3: Top 10 symbols by lastSeen
  const symbols = [...sessionState.exploredSymbols.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const symNames = symbols.map(s => s.name);
  const tier3 = truncateList(symNames, 10, "SYMBOLS");

  // Tier 4: Top 5 non-stale negative evidence
  const negEntries = sessionState.negativeEvidence
    .filter(e => !isStale(e))
    .sort((a, b) => b.ts - a.ts);
  const negQueries = negEntries.map(e => `${e.tool}:"${e.query}"`);
  const tier4 = truncateList(negQueries, 5, "NOT_FOUND");

  // Tier 5: Last 3 queries (filtered by repo)
  const recentQueries = sessionState.queries
    .filter(q => !repo ? (!effectiveRepo || q.repo === effectiveRepo) : q.repo === repo)
    .slice(-3)
    .reverse();
  const qStrings = recentQueries.map(q => `${q.tool}:"${q.query}"`);
  const tier5 = truncateList(qStrings, 3, "QUERIES");

  // Build with budget dropping
  const tiers = [tier2, tier3, tier4, tier5].filter(t => t.length > 0);
  for (const tier of tiers) {
    lines.push(tier);
  }

  let result = lines.join("\n");

  // Drop tiers from the bottom if over budget
  while (result.length > SNAPSHOT_CHAR_BUDGET && lines.length > 1) {
    lines.pop();
    result = lines.join("\n");
  }

  // Final hard cap (shouldn't be needed, but safety net)
  if (result.length > SNAPSHOT_CHAR_BUDGET) {
    result = result.slice(0, SNAPSHOT_CHAR_BUDGET - 3) + "...";
  }

  return result;
}

// ---------------------------------------------------------------------------
// getContext — full session state as structured JSON
// ---------------------------------------------------------------------------

export function getContext(repo?: string, includeStale = false): Record<string, unknown> {
  const symbols = [...state.exploredSymbols.values()];
  const files = [...state.exploredFiles.values()];
  const queries = repo
    ? state.queries.filter(q => q.repo === repo)
    : [...state.queries];
  const negativeEvidence = state.negativeEvidence.filter(e => {
    if (!includeStale && isStale(e)) return false;
    if (repo && e.repo !== repo) return false;
    return true;
  });

  return {
    session_id: state.sessionId,
    started_at: new Date(state.startedAt).toISOString(),
    call_count: state.callCount,
    explored_files: { count: files.length, items: files },
    explored_symbols: { count: symbols.length, items: symbols },
    queries: { count: queries.length, items: queries },
    negative_evidence: { count: negativeEvidence.length, items: negativeEvidence },
    caps: {
      symbols_capped: state.exploredSymbols.size >= MAX_SYMBOLS,
      files_capped: state.exploredFiles.size >= MAX_FILES,
      queries_capped: state.queries.length >= MAX_QUERIES,
      negative_evidence_capped: state.negativeEvidence.length >= MAX_NEGATIVE_EVIDENCE,
    },
  };
}

/**
 * Mark negative evidence entries as stale when a file changes.
 * Scoped to the changed file's subtree — entries with a filePattern
 * in a different subtree are not affected.
 */
export function invalidateNegativeEvidence(repo: string, changedFile: string): void {
  const changedDir = dirname(changedFile);
  for (const entry of state.negativeEvidence) {
    if (entry.repo !== repo) continue;
    if (entry.stale) continue;

    if (!entry.filePattern) {
      // No filePattern specified — any file change in the same repo invalidates
      entry.stale = true;
    } else {
      // Check if changed file is in the same subtree as the filePattern
      const patternDir = dirname(entry.filePattern);
      if (changedDir.startsWith(patternDir) || patternDir.startsWith(changedDir)) {
        entry.stale = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sidecar file management
// ---------------------------------------------------------------------------

function getDataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}

function getSidecarPath(): string {
  return join(getDataDir(), `session-${state.sessionId}.json`);
}

/** Serialize state for JSON — converts Maps to plain objects */
function serializeState(): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    callCount: state.callCount,
    exploredSymbols: Object.fromEntries(state.exploredSymbols),
    exploredFiles: Object.fromEntries(state.exploredFiles),
    queries: state.queries,
    negativeEvidence: state.negativeEvidence,
    h10Emitted: state.h10Emitted,
  };
}

/** Deserialize sidecar JSON back to SessionState shape (reconstructs Maps) */
export function deserializeState(raw: Record<string, unknown>): SessionState {
  return {
    sessionId: String(raw["sessionId"] ?? ""),
    startedAt: Number(raw["startedAt"] ?? 0),
    callCount: Number(raw["callCount"] ?? 0),
    exploredSymbols: new Map(Object.entries((raw["exploredSymbols"] ?? {}) as Record<string, SymbolEntry>)),
    exploredFiles: new Map(Object.entries((raw["exploredFiles"] ?? {}) as Record<string, FileEntry>)),
    queries: (raw["queries"] ?? []) as QueryEntry[],
    negativeEvidence: (raw["negativeEvidence"] ?? []) as NegativeEntry[],
    h10Emitted: Boolean(raw["h10Emitted"] ?? false),
  };
}

/** Write current state to sidecar file atomically (tmp + rename) */
export async function flushSidecar(): Promise<void> {
  try {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const finalPath = getSidecarPath();
    const tmpPath = finalPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(serializeState()), "utf-8");
    renameSync(tmpPath, finalPath);
  } catch {
    // Best-effort — never block
  }
}

/** Remove sidecar file (sync, called on process exit) */
export function cleanupSidecar(): void {
  try {
    unlinkSync(getSidecarPath());
  } catch {
    // Ignore — file may not exist
  }
}

/** Remove orphan sidecar files older than 24h */
export function cleanupOrphanSidecars(): void {
  try {
    const dataDir = getDataDir();
    const files = readdirSync(dataDir).filter(f => f.startsWith("session-") && f.endsWith(".json"));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const file of files) {
      const fullPath = join(dataDir, file);
      const stats = statSync(fullPath);
      if (stats.mtimeMs < cutoff) {
        unlinkSync(fullPath);
      }
    }
  } catch {
    // Best-effort
  }
}

/** Debounced sidecar flush */
export function scheduleSidecarFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    flushSidecar().catch(() => {});
    debounceTimer = null;
  }, 1000);
}

