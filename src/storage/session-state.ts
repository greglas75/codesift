import { getSessionId, extractResultChunks } from "./usage-tracker.js";

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
}

// ---------------------------------------------------------------------------
// Recording — called from wrapTool() on every tool call
// ---------------------------------------------------------------------------

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

  // Negative evidence: search tool with zero results
  if (SEARCH_TOOL_SET.has(tool) && extractResultChunks(resultData) === 0) {
    const filePattern = args["file_pattern"] as string | undefined;
    state.negativeEvidence.push({
      tool,
      query: (query ?? "") as string,
      repo,
      ts: now,
      stale: false,
      filePattern,
    });
  }
}

/**
 * Track a cache-hit tool call.
 * Increments callCount but does NOT evaluate negative evidence
 * (no result data available to inspect).
 */
export function recordCacheHit(
  tool: string,
  _args: Record<string, unknown>,
): void {
  state.callCount++;
}

// ---------------------------------------------------------------------------
// Negative evidence invalidation — called from watcher
// ---------------------------------------------------------------------------

import { dirname } from "node:path";

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
