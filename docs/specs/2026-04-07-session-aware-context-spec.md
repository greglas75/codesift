# Session-Aware Context -- Design Specification

> **spec_id:** 2026-04-07-session-aware-context-1845
> **topic:** Session-aware context tracking with compaction survival
> **status:** Approved
> **created_at:** 2026-04-07T18:45:00Z
> **approved_at:** 2026-04-07T19:30:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

When AI agents use CodeSift in long sessions, context window compaction discards the history of what the agent already explored. After compaction, the agent:

1. **Re-searches** for symbols and files it already found -- wasting tool calls and tokens
2. **Hallucinate missing features** after searching and finding nothing, then re-searching in loops
3. **Loses orientation** -- no memory of which modules, files, or symbols were relevant

jcodemunch v1.22 claims to solve this with session-aware routing. Codebase-Memory-MCP v0.6.0 added semantic session tracking. CodeSift currently tracks session state (`fileTreePaths`, `sessionSearchSymbolsCalled`, `sessionGetSymbolCount`) but does not expose it to agents.

**If we do nothing:** Agents waste 10-30% of tool calls on re-exploration after compaction, and negative evidence (searched, not found) is lost entirely -- the primary driver of hallucination loops.

## Design Decisions

### DD-1: Session state module location
**Chosen:** New `src/storage/session-state.ts` module with singleton API.
**Why:** `server-helpers.ts` already has ~370 lines mixing response formatting, hint logic, and session tracking. Extracting to a dedicated module improves testability and prevents further bloat. The existing session variables in `server-helpers.ts` will delegate to the new module.

### DD-2: PreCompact hook bridge
**Chosen:** Sidecar JSON file at `~/.codesift/session-<sessionId>.json`, written after every tool call (debounced async, ~1s).
**Why:** PreCompact hook runs as a separate process and cannot access MCP server's in-memory state. Sidecar file is the proven pattern (context-mode, mvara-ai/precompact-hook). I/O cost is negligible with debounced writes. Cleanup on process exit via `process.on('exit')`.

### DD-3: Negative evidence invalidation
**Chosen:** Hybrid -- TTL 120s + file watcher invalidation.
**Why:** TTL alone is arbitrary and may serve stale data. File watcher integration provides precise invalidation when the underlying codebase changes. TTL acts as a safety net for cases the watcher misses (e.g., external git pull). When watcher fires for a changed file, negative evidence entries whose query context plausibly relates to the changed file's subtree are marked `stale: true` (not all entries for the repo -- that would invalidate everything during active development).

### DD-4: Tool visibility
**Chosen:** `get_session_snapshot` is core (always visible in ListTools). `get_session_context` is deferred (discoverable via `discover_tools`).
**Why:** Snapshot (~200 tokens) is the critical tool for compaction survival -- agents must know it exists without discovery. Full context is a power-user deep dive used less frequently.

### DD-5: Hint code H10
**Chosen:** Emit `H10` after 50 tool calls, reminding agent to call `get_session_snapshot`.
**Why:** On platforms without PreCompact hook (Cursor, Codex, Gemini), agents need a nudge. Follows the proven H1-H9 pattern. Emitted once per session, not repeatedly.

## Solution Overview

```
Agent tool call
    |
    v
wrapTool() in server-helpers.ts
    |
    +--> recordToolCall(tool, args, result) --> session-state.ts (in-memory)
    |                                              |
    |                                              +--> debounced write --> sidecar JSON
    |
    v
Tool response (with H10 hint if call_count >= 50)

---

PreCompact hook fires (Claude Code only)
    |
    v
codesift precompact-snapshot (CLI command)
    |
    v
Reads sidecar JSON --> formats ~200 token snapshot --> stdout
    |
    v
Claude Code injects snapshot into context before compaction

---

File watcher event (file changed/added)
    |
    v
session-state.ts: invalidate negative evidence for affected repo
```

## Detailed Design

### Data Model

```typescript
// src/storage/session-state.ts

interface SessionState {
  sessionId: string;         // from usage-tracker SESSION_ID
  startedAt: number;         // Date.now() at module load
  callCount: number;         // total tool calls this session

  // Explored context (deduped, capped)
  exploredSymbols: Map<string, SymbolEntry>;  // symbolId -> entry, max 500
  exploredFiles: Map<string, FileEntry>;      // filePath -> entry, max 300
  queries: QueryEntry[];                       // chronological, max 200

  // Negative evidence
  negativeEvidence: NegativeEntry[];           // max 300
}

interface SymbolEntry {
  symbolId: string;
  name: string;
  file: string;
  firstSeen: number;
  lastSeen: number;
  accessCount: number;
}

interface FileEntry {
  path: string;
  firstSeen: number;
  lastSeen: number;
  accessCount: number;
}

interface QueryEntry {
  tool: string;
  query: string;
  repo: string;
  ts: number;
  resultCount: number;
}

interface NegativeEntry {
  tool: string;
  query: string;
  repo: string;
  ts: number;
  stale: boolean;            // set lazily at read time (TTL or watcher)
}
```

**Staleness evaluation (dual model):**
- **Watcher-based:** When the file watcher fires for a changed/added file, entries whose query context plausibly relates to the changed file are marked `stale = true` eagerly (mutation). Relevance check: the changed file's directory subtree must overlap with the entry's `file_pattern` arg (if present) or the entry's repo. This prevents unrelated file saves (CSS, config) from invalidating all negative evidence.
- **TTL-based:** Evaluated lazily at read time in `getSnapshot()` and `getContext()`. If `Date.now() - entry.ts > 120_000`, the entry is treated as stale regardless of the `stale` field.
- Both mechanisms are complementary: watcher provides precise invalidation, TTL provides a safety net.

**Zero-results detection:** Negative evidence is recorded when the tool's **parsed result data** contains zero items -- not the MCP transport-level chunk count. The detection uses the same `extractResultChunks()` function from `usage-tracker.ts` which inspects `data.results`, `data.symbols`, `data.matches`, `data.references`, `data.files` arrays. If `extractResultChunks(resultData) === 0` AND the tool is in the search tool set (`search_text`, `search_symbols`, `codebase_retrieval`, `semantic_search`, `find_references`), a `NegativeEntry` is appended.

**File path extraction from args:** For tools that operate on a single file (`Edit`, `Write`, `get_file_outline`, `index_file`), the file path is stored in `args.file_path` or `args.path`, not in result data. `recordToolCall` must also extract these arg-based paths and add them to `exploredFiles`.
```

**Caps and eviction:**
- `exploredSymbols`: max 500 entries. LRU eviction by `lastSeen`.
- `exploredFiles`: max 300 entries. LRU eviction by `lastSeen`.
- `queries`: max 200 entries. FIFO -- oldest removed first.
- `negativeEvidence`: max 300 entries. FIFO -- oldest removed first. Entries with `stale: true` evicted first.

### API Surface

#### `get_session_snapshot` (core tool)

**Parameters:**
- `repo` (optional): filter snapshot to specific repo. Default: repo from the most recent tool call (`queries[-1].repo`). This prevents multi-repo sessions from polluting the snapshot with irrelevant cross-repo context.
**Returns:** Plain text string, hard-capped at 700 characters (~200 tokens).

Priority-ordered tiers:
1. **Header** (~15 tok): `session_id`, `started_at`, `call_count`
2. **Top 5 files** (~30 tok): by `accessCount` desc, then `lastSeen` desc
3. **Top 10 symbols** (~50 tok): by `lastSeen` desc (most recent first)
4. **Top 5 negative evidence** (~30 tok): non-stale only, by `ts` desc
5. **Last 3 queries** (~30 tok): most recent

If any tier overflows, truncate with `+N more` suffix (e.g., `SYMBOLS: wrapTool, registerTools, buildHint +47 more`). Hard character budget: 700 chars. If exceeded after all tiers, drop tier 5, then 4. Truncation is implicit from the `+N more` suffixes -- no separate `truncated` flag (the return type is plain text).

**Deterministic output:** Same state always produces same string (stable sort, no random elements).

#### `get_session_context` (deferred tool, requires `repo` param optional)

**Parameters:**
- `repo` (optional): filter to specific repo
- `include_stale` (optional, default false): include stale negative evidence

**Returns:** Structured JSON object with full session state:
```json
{
  "session_id": "...",
  "started_at": "ISO-8601",
  "call_count": 123,
  "explored_files": { "count": 45, "items": [...] },
  "explored_symbols": { "count": 200, "items": [...] },
  "queries": { "count": 80, "items": [...] },
  "negative_evidence": { "count": 12, "items": [...] },
  "caps": { "symbols_capped": false, "files_capped": false, ... }
}
```

Progressive cascade shortener registered: >52.5K chars → compact (counts + top 3 each), >87.5K → counts only.

#### Session state recording (internal, not a tool)

```typescript
// Called from wrapTool() after every tool call
function recordToolCall(
  tool: string,
  args: Record<string, unknown>,
  resultChunks: number,
  resultData: unknown
): void

// Called from watcher integration
function invalidateNegativeEvidence(repo: string): void

// Called from resetSessionState() for test isolation
function resetSession(): void

// Sidecar file management
function flushSidecar(): Promise<void>  // debounced, async, atomic (write to .tmp then rename)
function cleanupSidecar(): void         // sync, called on process exit
function cleanupOrphanSidecars(): void  // on module load, delete session-*.json files older than 24h
```

**Recording logic in `recordToolCall`:**
- Extract `query` from args (if present)
- Extract symbol IDs from result data (for search_symbols, get_symbol, find_references, etc.)
- Extract file paths from result data (for get_file_outline, get_file_tree, search_text, etc.) AND from `args.file_path`/`args.path` for single-file tools (Edit, Write, index_file)
- If `extractResultChunks(resultData) === 0` and tool is in the search tool set → append to `negativeEvidence` (see Zero-results detection above)
- Increment `callCount`
- All writes synchronous (no `await` between state reads and writes)

#### PreCompact CLI command

```bash
codesift precompact-snapshot
```

- Reads `HOOK_TOOL_INPUT` env var (JSON with `session_id`)
- Reads sidecar file at `~/.codesift/session-<session_id>.json`
- Formats snapshot string (same format as `get_session_snapshot`)
- Writes to stdout
- Exits 0 (never blocks compaction)
- If sidecar file missing or unreadable: exits 0 with empty output

#### Hook installation

`codesift setup claude --hooks` extended to install:
```json
{
  "hooks": {
    "PreCompact": [{
      "matcher": "",
      "command": "codesift precompact-snapshot"
    }]
  }
}
```

#### Hint code H10

Emitted once per session when `callCount >= 50`:
```
H10  50+ tool calls this session → call get_session_snapshot to preserve context
```

Added to `buildResponseHint()` in `server-helpers.ts`. Uses a `sessionH10Emitted: boolean` flag to ensure single emission.

### Integration Points

| Component | Change | How |
|-----------|--------|-----|
| `src/storage/session-state.ts` | **NEW** | Singleton module: SessionState, recordToolCall, getContext, getSnapshot, resetSession, flushSidecar |
| `src/server-helpers.ts` | **MODIFY** | Import session-state, call `recordToolCall()` inside `wrapTool()`, add H10 to `buildResponseHint()`, delegate existing session vars to session-state |
| `src/register-tools.ts` | **MODIFY** | Add `get_session_snapshot` (core) and `get_session_context` (deferred) to TOOL_DEFINITIONS, update CORE_TOOL_NAMES |
| `src/cli/hooks.ts` | **MODIFY** | Add `handlePrecompactSnapshot()` function |
| `src/cli/commands.ts` | **MODIFY** | Add `"precompact-snapshot"` to COMMAND_MAP |
| `src/cli/setup.ts` | **MODIFY** | Add PreCompact hook constant, merge into `setupClaudeHooks()` |
| `src/storage/watcher.ts` | **MODIFY** | On file change event, call `invalidateNegativeEvidence(repo)` |
| `src/instructions.ts` | **MODIFY** | Add session tools to CODESIFT_INSTRUCTIONS |
| `src/server.ts` | **MODIFY** | Re-export `resetSession` for test compat, register sidecar cleanup on `process.on('exit')` |
| `CLAUDE.md` | **MODIFY** | Update tool count (64 → 66), architecture section |

### Edge Cases

| ID | Scenario | Handling |
|----|----------|----------|
| EC-1 | Unbounded memory in long sessions | Caps: 500 symbols, 300 files, 200 queries, 300 negative evidence. LRU/FIFO eviction. |
| EC-2 | Same symbol explored 50x | `Map<string, SymbolEntry>` deduplicates by symbolId, increments `accessCount` |
| EC-3 | MCP server restart = state lost | `session_id` changes, agent can detect. Sidecar file from old session ignored (different ID). |
| EC-4 | Concurrent tool calls race condition | All session state writes synchronous (no await). Node.js single-thread guarantee. |
| EC-5 | PreCompact hook doesn't fire | `get_session_snapshot` callable proactively. H10 hint reminds agent. |
| EC-6 | Negative evidence stale after file creation | Watcher calls `invalidateNegativeEvidence()` scoped to relevant subtree. TTL 120s as safety net. |
| EC-7 | Snapshot exceeds 200 tokens | Hard 700-char cap. Priority tiers dropped from bottom. Truncation indicated by `+N more` suffixes in each tier. |
| EC-8 | Cursor/Codex — no PreCompact | Tool works identically. Only auto-injection is Claude-specific. |
| EC-9 | `get_session_context` huge response | Compact shortener registered with progressive cascade. |
| EC-10 | Cache hit not tracked | Track session state on ALL calls including cache hits in `wrapTool()`. |
| EC-11 | PreCompact hook, MCP not running | `precompact-snapshot` CLI reads sidecar file directly, no MCP connection needed. Exit 0 always. |
| EC-12 | Empty `transcript_path` in hook input | Guard against null/empty (Claude Code issue #13668). |

## Acceptance Criteria

1. `get_session_snapshot` returns a string of at most 700 characters (~200 tokens) with session_id, call_count, top files, top symbols, negative evidence, and recent queries.
2. `get_session_snapshot` output is deterministic: same session state always produces identical output.
3. `get_session_context` returns full session state as structured JSON with explored symbols, files, queries, and negative evidence (with `stale` flag).
4. `wrapTool()` records every tool call (including cache hits) into session state without blocking the tool response.
5. Negative evidence is recorded automatically when a search tool returns zero results.
6. Negative evidence entries are marked `stale: true` when the file watcher detects changes in the relevant repo.
7. Negative evidence entries older than 120s are marked `stale: true` via TTL.
8. Stale negative evidence is excluded from `get_session_snapshot`.
9. Session state caps are enforced: 500 symbols (LRU), 300 files (LRU), 200 queries (FIFO), 300 negative evidence (FIFO with stale-first eviction).
10. `codesift precompact-snapshot` CLI command reads sidecar JSON and outputs snapshot to stdout, exits 0 always.
11. `codesift setup claude --hooks` installs PreCompact hook entry alongside existing PreToolUse/PostToolUse hooks.
12. Sidecar JSON file written debounced (~1s) after each tool call, cleaned up on process exit.
13. H10 hint code emitted once per session after 50 tool calls.
14. `get_session_snapshot` is a core tool (visible in ListTools). `get_session_context` is deferred (discoverable).
15. `resetSession()` clears all session state for test isolation.
16. All existing tests pass without modification (except tests that assert tool count or session reset behavior).
17. `get_session_context` is NOT in `CORE_TOOL_NAMES` -- it uses the existing `disable()` / `discover_tools` mechanism for deferred tools.
18. Sidecar file writes use atomic rename (write to `.tmp`, then `fs.renameSync`) to prevent corruption from concurrent reads.
19. On module load, orphan sidecar files older than 24h are cleaned up (best-effort, no error on failure).
20. `get_session_snapshot` defaults to the most recent repo when `repo` param is omitted.
21. Watcher invalidation of negative evidence is scoped to the changed file's subtree, not all entries for the repo.

## Out of Scope

- **`plan_turn`** — opening-move router with confidence levels. Complex, unproven value. Can add later.
- **`register_edit`** — explicit edit tracking by agents. `wrapTool()` already captures Edit/Write calls via the PostToolUse hook chain.
- **Persistent session state across restarts** — SQLite/FTS5 storage. Not needed until proven.
- **Cross-session context** — already covered by `search_conversations` / `index_conversations`.
- **Token savings tracker in response meta** — separate feature, not session-aware context.

## Open Questions

None -- all questions resolved in Phase 2.
