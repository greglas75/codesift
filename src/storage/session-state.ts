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

/** Tools whose file_path/path arg should be tracked in exploredFiles */
const SINGLE_FILE_TOOLS = new Set([
  "get_file_outline", "index_file",
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
  if (query && typeof query === "string") {
    const repo = (args["repo"] ?? "") as string;
    state.queries.push({ tool, query, repo, ts: now, resultCount: resultChunks });
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
