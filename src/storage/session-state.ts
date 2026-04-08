import { getSessionId } from "./usage-tracker.js";

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
