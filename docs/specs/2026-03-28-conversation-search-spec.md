# Conversation Search — Design Specification

> **Date:** 2026-03-28
> **Status:** Approved
> **Author:** zuvo:brainstorm

## Problem Statement

Developers using Claude Code accumulate thousands of conversations containing critical knowledge: why decisions were made, what approaches were rejected, how bugs were debugged, what trade-offs were considered. This knowledge lives in JSONL files on disk (`~/.claude/projects/`) but is effectively invisible — you can't search it, agents can't access it, and it's lost when you can't remember which session it was in.

Existing tools (episodic-memory, ticpu, claude-history) solve parts of this but none combine conversation search with code intelligence. None offer cross-referencing between code symbols and the conversations that discussed them. None handle compaction intelligently. None use hybrid BM25+semantic search.

CodeSift already indexes code with 39 MCP tools, hybrid search, and the richest code intelligence in the ecosystem. Adding conversation indexing creates a unified knowledge layer no competitor has: **"your codebase has two layers of knowledge — the code itself, and the conversations that shaped it. CodeSift searches both."**

## Design Decisions

### D1: Conversations as a special repo type (not raw index_folder)

**Chosen:** Conversations are indexed as a separate repo with a dedicated extractor, discoverable via `list_repos` as `conversations/{project-name}`.

**Why:** `index_folder` assumes code files with tree-sitter-parseable ASTs. Conversations need different parsing (JSONL events, not code), different chunking (turn-pair, not AST boundaries), and different noise filtering. A dedicated path avoids polluting the code index while reusing all downstream retrieval infrastructure.

**Rejected:** Treating conversations as regular files in existing repos — would mix code and conversation results without metadata distinction.

### D2: Auto-discovery + session-end hook (zero configuration)

**Chosen:** Two complementary mechanisms:
1. **Auto-discovery at startup:** CodeSift detects `cwd`, computes the Claude conversation path (`~/.claude/projects/{encoded-cwd}/`), and indexes in background if the directory exists. Incremental (mtime check).
2. **Session-end hook:** A post-session hook triggers `codesift index-conversations` for immediate availability. Installed automatically when conversation indexing is first detected.

**Why:** Manual indexing is a non-starter — users won't run commands. Auto-discovery catches history; the hook catches the just-finished session.

**Rejected:** Real-time file watcher on `~/.claude/projects/` — 16K+ files, excessive overhead. Manual `index_conversations` command — users are lazy, it won't get used.

### D3: Turn-pair chunking with noise filtering

**Chosen:** Each indexable unit = one user turn + the subsequent assistant text response. Tool results truncated to ~200 chars (preserve intent, drop file dumps). Skip record types: `progress`, `file-history-snapshot`, `queue-operation`, `system` (except `compact_boundary` for detection).

**Why:** Without filtering, ~70% of conversation content is tool output noise (file dumps from Read/Bash/Grep) that duplicates the code index. Turn-pair is the natural semantic unit — it captures a question and its answer together.

**Rejected:** Message-level chunking (too granular, loses context), session-level chunking (too large, poor recall), no filtering (index would be mostly noise).

### D4: Compaction-aware parsing

**Chosen:** Detect `compact_boundary` markers and `isCompactSummary` flags. Skip summary injection messages during normal indexing (originals are still in the file). Index the last summary per session as a separate meta-document with lower weight (useful for high-level "what was this session about?" queries). Flag subagent orphans (`agent-acompact-*` without siblings) as `compacted_only`.

**Why:** No existing tool handles compaction. Naive parsing double-indexes content (originals + summary). Multi-compacted files (260 on user's machine with 2-6 boundaries each) would have massive duplication.

**Rejected:** Ignoring compaction entirely (like all competitors do) — causes duplication and noise.

### D5: Three new MCP tools + codebase_retrieval extension

**Chosen:**
- `index_conversations(project_path?)` — explicit indexing trigger (also used by hook/auto-discovery internally)
- `search_conversations(query, project?, limit?)` — hybrid BM25F + semantic search over conversations
- `find_conversations_for_symbol(symbol_name, repo)` — cross-reference: find conversations that discuss a code symbol

Plus: new `"conversation"` query type in `codebase_retrieval` for organic discovery by agents already using batch queries.

**Why:** Minimal tool surface (3 tools) covers all use cases. `find_conversations_for_symbol` is the unique differentiator. `codebase_retrieval` extension means agents don't need to learn new tools.

**Rejected:** Larger tool surface (get_conversation, summarize_session, reindex, get_session_messages) — ticpu has 6 tools but most are rarely used. Keep it minimal.

### D6: BM25F first, embeddings optional

**Chosen:** BM25F search works immediately without API calls or configuration. Semantic embeddings use the existing CodeSift embedding pipeline (Voyage/OpenAI/Ollama) and are generated incrementally when available. If no embedding provider configured, BM25-only search still works.

**Why:** Zero-configuration requirement. BM25F covers ~70% of searches (exact terms: error messages, function names, library names). Semantic adds the remaining 30% (conceptual: "how did we solve the caching problem?"). Not blocking basic functionality on embedding setup.

### D7: Word-splitting tokenizer for natural language

**Chosen:** Add a word-splitting tokenizer alongside the existing camelCase-aware `tokenizeIdentifier`. Conversations are natural language — splitting on whitespace + punctuation produces better BM25 tokens than camelCase splitting.

**Why:** `tokenizeIdentifier("processPayment")` → `["process", "payment"]` (good for code). But for conversation text: "we decided to use Redis because Postgres was too slow" needs word-level tokens, not identifier-level.

### D8: Scope — Claude Code only, current project only (v1)

**Chosen:** Index only Claude Code conversations from `~/.claude/projects/`. Auto-discovery scopes to the current project (cwd). `index_conversations` can target any project path explicitly.

**Why:** Claude Code format is known and stable. Scoping to current project keeps index small and startup fast. Cross-project search is opt-in via explicit path.

**Rejected:** Auto-indexing ALL projects (7.7GB, 16K files — too heavy for startup). Supporting Cursor/Codex/Aider formats (v2).

## Solution Overview

A new conversation extractor parses Claude Code JSONL files into `CodeSymbol[]` objects, which flow through the existing BM25F + embedding + retrieval pipeline unchanged. Three new MCP tools expose conversation search, and `codebase_retrieval` gets a `"conversation"` query type. Auto-discovery at startup + a session-end hook ensure zero-configuration operation.

```
~/.claude/projects/{project}/*.jsonl
        ↓
  conversation extractor (parse JSONL, filter noise, turn-pair chunking)
        ↓
  CodeSymbol[] with kind="conversation_turn"
        ↓
  existing pipeline: BM25F index + optional embeddings
        ↓
  search_conversations / find_conversations_for_symbol / codebase_retrieval
```

## Detailed Design

### Data Model

**New SymbolKind values** in `src/types.ts`:
- `"conversation_turn"` — a user+assistant exchange pair
- `"conversation_summary"` — a compaction summary (lower search weight)

**CodeSymbol mapping for conversation turns:**

| CodeSymbol field | Conversation mapping |
|------------------|---------------------|
| `id` | `{repo}:{file}:{turn_index}` |
| `name` | Truncated user question (first 100 chars) |
| `kind` | `"conversation_turn"` |
| `file` | Relative path to JSONL file |
| `start_line` | Line number of user message in JSONL |
| `end_line` | Line number of assistant message end |
| `source` | User question + assistant text response (truncated to MAX_SOURCE_LENGTH) |
| `docstring` | Session metadata: `timestamp \| gitBranch \| tools_used` |
| `signature` | `"{role}: {first_line_of_message}"` for both user and assistant |
| `parent` | Session ID (groups turns within a session) |
| `tokens` | Word-split tokens (not camelCase) for BM25 |

**Conversation repo naming:** `conversations/{project-folder-name}` (e.g., `conversations/codesift-mcp`)

### API Surface

#### `index_conversations`

```typescript
index_conversations(project_path?: string): {
  sessions_found: number;
  turns_indexed: number;
  skipped_noise_records: number;
  compacted_sessions: number;
  elapsed_ms: number;
}
```

- If `project_path` omitted: auto-detect from server's `cwd`
- Incremental: checks mtime/size, skips unchanged files
- Files >10MB: skip with warning (v1 cap)

#### `search_conversations`

```typescript
search_conversations(
  query: string,
  project?: string,     // default: current project
  limit?: number,       // default: 10, max: 50
): {
  results: ConversationSearchResult[];
  total_matches: number;
}

interface ConversationSearchResult {
  session_id: string;
  timestamp: string;
  git_branch: string;
  user_question: string;    // the question that was asked
  assistant_answer: string; // the answer (truncated)
  score: number;
  file: string;
  turn_index: number;
}
```

#### `find_conversations_for_symbol`

```typescript
find_conversations_for_symbol(
  symbol_name: string,
  repo: string,          // code repo to resolve symbol from
  limit?: number,        // default: 5
): {
  symbol: { name: string; file: string; kind: string };
  conversations: ConversationSearchResult[];
  session_count: number;
}
```

Searches conversation text for mentions of the symbol name. Returns conversations where the symbol was discussed, with surrounding context.

**Symbol resolution behavior:**
- First, resolves `symbol_name` against the code repo via `search_symbols` to confirm it exists and get its full name.
- If symbol not found in repo: falls back to plain-text search for the name string in conversations (still useful — user may have discussed a function that was later deleted).
- Search is **case-insensitive** and matches **whole words only** (e.g., `processPayment` matches "processPayment" but not "processPaymentById"). This prevents false positives from partial matches.

#### `codebase_retrieval` extension

New query type with Zod schema:

```typescript
const ConversationSubQuerySchema = z.object({
  type: z.literal("conversation"),
  query: z.string().describe("Search query for conversations"),
  project: z.string().optional().describe("Project name filter (default: current project)"),
  limit: z.number().optional().default(5).describe("Max results (default: 5)"),
});
```

Example:
```json
{"type": "conversation", "query": "why did we choose Redis for caching"}
```

Routes through `search_conversations` internally. Results returned alongside code results in the same batch response.

### Integration Points

**Files to modify:**

| File | Change |
|------|--------|
| `src/parser/extractors/conversation.ts` | **NEW** — conversation JSONL extractor |
| `src/parser/symbol-extractor.ts` | Re-export `extractConversationSymbols` |
| `src/parser/parser-manager.ts` | Add `.jsonl` → `"conversation"` to `EXTENSION_MAP` |
| `src/tools/index-tools.ts` | Add `else if (language === "conversation")` in `parseOneFile()` |
| `src/tools/conversation-tools.ts` | **NEW** — MCP tool handlers for 3 new tools |
| `src/types.ts` | Add `"conversation_turn"`, `"conversation_summary"` to SymbolKind |
| `src/search/chunker.ts` | Remove `.jsonl` from `SKIP_EXTENSIONS`, add turn-boundary chunking |
| `src/search/bm25.ts` | Add word-split tokenizer for conversation content |
| `src/retrieval/codebase-retrieval.ts` | Handle `type: "conversation"` queries |
| `src/retrieval/retrieval-schemas.ts` | Add `"conversation_turn"`, `"conversation_summary"` to `SymbolKindSchema` enum; add `ConversationSubQuerySchema` to `SubQuerySchema` discriminated union |
| `src/storage/registry.ts` | Support `conversations/` namespace in repo registry |
| `src/server.ts` | Register 3 new MCP tools; auto-discovery on startup |

**Files unchanged:** LSP bridge, all existing tools, watcher (not used for conversations), walk.ts (not used — we scan `~/.claude/projects/` directly).

### Auto-Discovery Flow

```
MCP server starts
  ↓
Read cwd from environment
  ↓
Compute Claude path: ~/.claude/projects/{cwd with / → -}/
  ↓
Directory exists?
  ├─ NO → skip (no conversations for this project)
  └─ YES → register as conversations/{project-name}
           ↓
         Check index freshness (mtime of newest .jsonl vs last index time)
           ├─ Fresh → skip
           └─ Stale → index_conversations() in background
```

### Session-End Hook

Installed automatically on first auto-discovery. Writes to the project's `.claude/settings.local.json` (not global settings):

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "command": "codesift index-conversations --quiet"
    }]
  }
}
```

The `Stop` hook fires when Claude stops generating. `--quiet` suppresses output to avoid noise in the terminal. Incremental — only processes new/changed files since last index.

**Installation logic:** On first auto-discovery, check if `.claude/settings.local.json` exists and already has the hook. If not, create/merge it. If the file exists with other hooks, append without overwriting. Log to stderr: `"CodeSift: conversation index hook installed in .claude/settings.local.json"`.

### Conversation Extractor Logic

```
Read JSONL file line by line
  ↓
For each line, parse JSON:
  ↓
Skip if type NOT in ["user", "assistant"]
Skip if type == "user" AND isCompactSummary == true (summary injection)
  ↓
Detect compact_boundary → note position, extract last summary for meta-doc
  ↓
Pair user + next assistant → one ConversationTurn
  ↓
For user message:
  - Extract text content (string or content[].text blocks)
  - Skip image blocks (replace with [image])
  ↓
For assistant message:
  - Extract text blocks
  - For tool_use blocks: keep tool name + truncated input (200 chars)
  - Skip tool_result content entirely (it's noise / duplicates code index)
  - Include thinking blocks at reduced weight
  ↓
Produce CodeSymbol with:
  - name = user question (first 100 chars)
  - source = user text + "\n---\n" + assistant text
  - docstring = timestamp | branch | tools_used
  - kind = "conversation_turn"
  - tokens = word_split(source)
```

### Edge Cases

**Malformed JSONL lines:** `try { JSON.parse(line) } catch { continue }` — same pattern as existing chunk/embedding stores. Never fail the whole file.

**Files >10MB:** Skip with warning logged to stderr. v1 cap — covers 99% of sessions (avg 484KB). Revisit with streaming parser in v2.

**Empty sessions:** Sessions with 0 user/assistant turns after filtering → skip, don't index.

**Multi-compaction (2-6 boundaries per file):** Only index the LAST summary as meta-doc. Skip intermediate summaries.

**Subagent compact orphans (`agent-acompact-*`):** Index the summary as the sole content. Flag `kind: "conversation_summary"`.

**Conversations with no text (only tool calls):** Some sessions are pure automation. If no text content after filtering → skip.

**Claude conversation path encoding:** `cwd` with `/` replaced by `-`. Handle edge cases: spaces in path, unicode characters, symlinks.

## Acceptance Criteria

1. When CodeSift MCP server starts in a project that has Claude conversations in `~/.claude/projects/{encoded-cwd}/`, conversations are auto-discovered and indexed in background without any user action.
2. A session-end hook is installed that re-indexes conversations after each Claude session.
3. `search_conversations("auth bug")` returns relevant conversation turns ranked by BM25F score, with session metadata (timestamp, branch).
4. `find_conversations_for_symbol("processPayment", "local/my-project")` returns conversation turns where that function was discussed.
5. `codebase_retrieval` with `type: "conversation"` returns conversation results alongside code results in a single batch response.
6. Tool result content (Read/Bash/Grep file dumps) is NOT indexed — only tool names and truncated inputs are kept.
7. `isCompactSummary` messages are skipped during indexing. The last compaction summary per session is indexed as a separate `conversation_summary` symbol with lower weight.
8. Files >10MB are skipped with a warning.
9. Incremental re-indexing only processes new/changed files (mtime + size check).
10. BM25F search works without any embedding provider configured.
11. Conversation results are distinguishable from code results via `kind: "conversation_turn"`.

## Out of Scope

- **PII/secret detection:** User's own machine, opt-in by nature of having CodeSift installed.
- **Streaming parser for >10MB files:** v2 — cap at 10MB for v1.
- **Subagent tree reconstruction:** Flat index, no parent-child linking.
- **Cross-project search by default:** Only current project auto-discovered. Explicit path for other projects.
- **Local embeddings (Transformers.js):** Use existing embedding pipeline.
- **Cursor/Codex/Aider support:** Claude Code only in v1.
- **Session viewer / cost analytics:** Other tools do this, not CodeSift's value prop.
- **Date/project filtering in search:** Add when needed, not in v1 scope.
- **Real-time file watcher for conversations:** Startup + hook is sufficient.
- **Modifying user's global Claude settings** — hook is installed per-project in `.claude/settings.local.json`, not in global `~/.claude/settings.json`.

## Open Questions

None — all design questions were resolved during brainstorm.
