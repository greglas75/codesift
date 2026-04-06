# Token & Agent Optimization Suite — Design Specification

> **spec_id:** 2026-04-05-token-agent-optimization-1830
> **topic:** 5 token reduction and agent acceleration features for CodeSift MCP
> **status:** Approved
> **created_at:** 2026-04-05T18:30:00Z
> **approved_at:** 2026-04-05T19:00:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift MCP has 61 tools. Each tool schema costs ~200 tokens in the system prompt. At session start, the LLM receives ~12K tokens of tool schemas before seeing the user's question. Competitors (Speakeasy, lean-ctx, Serena) have solved this with dynamic tool loading, progressive response shortening, and enforcement hooks. Additionally, `search_text` (36% of all calls) returns raw line-level grep hits without symbol context — agents waste follow-up calls to understand what function each hit belongs to.

## Design Decisions

### D1: Tool visibility via SDK `disable()` instead of 3-meta-tool wrapper
**Chosen:** Use MCP SDK's native `registeredTool.disable()` to hide non-core tools from ListTools. Add `describe_tools` meta-tool for on-demand schema retrieval. NO `execute_tool` wrapper.
**Why:** `execute_tool` wrapper breaks cache key dedup, hint tracking (H2), and adds an indirection layer. With `disable()`, tools remain directly callable by name once the agent discovers them via `discover_tools`→`describe_tools`.
**Rejected:** Speakeasy's 3-meta-tool pattern (search→describe→execute) — `execute_tool` adds complexity without benefit since disabled tools are still callable in MCP.

### D2: formatTable helper instead of TOON format
**Chosen:** Add `formatTable(headers, rows)` utility for tabular outputs. Apply to hotspots, complexity, clones, usage_stats.
**Why:** Existing formatters already achieve 50-70% token reduction vs JSON. TOON (YAML-style) gives marginal improvement (~10-15%) with risks: YAML reserved chars in code strings, truncation mid-record, hint prefix interference.
**Rejected:** Full TOON serializer — marginal gain doesn't justify the complexity and parsing risks.

### D3: PreToolUse hooks — explicit opt-in, local-only
**Chosen:** New CLI subcommands `codesift precheck-read` and `codesift postindex-file`. Installation via `codesift setup claude --hooks`. Writes to `settings.local.json` only.
**Why:** Hooks modify user's dev environment — must be explicit and reversible. Local-only avoids team conflicts.
**Rejected:** Auto-install during `setup` — too aggressive for a behavior-changing feature.

### D4: Progressive shortening cascade — respect explicit params
**Chosen:** Cascade in `formatResponse`: >52,500 chars (~15K tokens) → compact, >87,500 chars (~25K tokens) → counts, >105,000 chars (~30K tokens) → hard truncate. Skips cascade when LLM specified `detail_level` or `token_budget`.
**Why:** Automatic graceful degradation prevents truncation failures while respecting explicit agent intent.
**Rejected:** LLM-generated summaries at the "summary" level — adds inference cost and non-determinism.

### D5: search_text v2 — ranked mode as opt-in param
**Chosen:** New `ranked: true` param on `search_text`. When enabled, runs 4-phase pipeline: grep→classify→dedup→rank. Default false for backward compat.
**Why:** 36% of all calls are `search_text`. Symbol promotion (mapping hits to containing functions) eliminates 1-3 follow-up `get_symbol` calls per search.
**Rejected:** Always-on pipeline — stale index misclassification risk requires opt-in until proven reliable.

## Solution Overview

5 features implemented sequentially. Each is independently testable and shippable.

```
F1: Tool Visibility     → register-tools.ts  (disable non-core + describe_tools)
F2: formatTable          → formatters.ts      (tabular output helper)
F3: Hooks               → cli/commands.ts     (precheck-read + postindex-file)
F4: Progressive Cascade → server-helpers.ts   (compact→counts→truncate)
F5: search_text v2      → search-tools.ts     (classify→dedup→rank)
```

## Detailed Design

### F1: Tool Visibility + describe_tools

**Files:** `src/register-tools.ts`, `src/server.ts` (no change)

**Changes:**
- Store `RegisteredTool` handles from `server.tool()` in module-level `Map<string, RegisteredTool>`
- Call `handle.disable()` for each non-core tool after registration
- New `describeTools(names: string[]): DescribeToolsResult` function — reuses Zod param extraction from `discoverTools`
- New `describe_tools` MCP tool with schema: `{ names: string[], reveal?: boolean }`
- Optional `reveal: true` → calls `handle.enable()` + `sendToolListChanged()`

**New type:**
```typescript
interface DescribeToolsResult {
  tools: Array<{ name: string; category: string; description: string; is_core: boolean; params: Array<{ name: string; required: boolean; description: string }> }>;
  not_found: string[];
}
```

**MCP output format:** Returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }` — JSON string inside the standard MCP text envelope. Agents parse the JSON to get structured tool metadata. This matches the pattern used by `discover_tools` and `list_repos`.

**LOC:** +65

### F2: formatTable Helper

**Files:** `src/formatters.ts`, `src/storage/usage-stats.ts`

**Changes:**
- New `formatTable(headers: string[], rows: string[][], options?: { maxColWidth?: number }): string`
- Space-padded columns with dash separator row
- Replace manual padding in `formatHotspots`, `formatComplexity`, `formatClones`
- Replace manual table in `formatUsageReport` (usage-stats.ts)

**LOC:** +15 net

### F3: PreToolUse + PostToolUse Hooks

**Files:** `src/cli/commands.ts`, `src/cli/setup.ts`, `src/cli/help.ts`

**Changes:**
- `handlePrecheckRead`: reads `HOOK_TOOL_INPUT` env, checks extension + line count, exits 0 or 2 with redirect message
- `handlePostindexFile`: reads `HOOK_TOOL_INPUT` env, calls `indexFile(path)` for code files
- `setupClaudeHooks()`: merges PreToolUse/PostToolUse entries into `.claude/settings.local.json`
- `setup claude --hooks` flag enables hook installation
- `CODE_EXTENSIONS` set: .ts/.tsx/.js/.jsx/.py/.go/.rs/.java/.c/.cpp/.cs/.rb/.php/.swift/.kt/.scala/.vue/.svelte
- Default threshold: 200 lines (configurable via `CODESIFT_READ_HOOK_MIN_LINES`)

**LOC:** +160

### F4: Progressive Response Shortening

**Files:** `src/server-helpers.ts`, `src/formatters.ts`, `src/register-tools.ts`

**Changes:**
- `SHORTENING_REGISTRY: Map<string, { compact?: (data) => string; counts?: (data) => string }>`
- `registerShortener(toolName, formatters)` exported from server-helpers
- Cascade in `formatResponse`: if text > 52,500 chars → compact, > 87,500 → counts, > 105,000 → hard truncate
- Skip cascade for: `codebase_retrieval`, calls with explicit `detail_level`/`token_budget`
- `[compact]` or `[counts]` annotation prepended to cascaded responses
- New formatters: `formatComplexityCompact/Counts`, `formatClonesCompact/Counts`, `formatHotspotsCompact/Counts`

**LOC:** +155

### F5: search_text v2 (4-Phase Symbol Promotion)

**Files:** `src/tools/search-tools.ts`, `src/types.ts`, `src/register-tools.ts`

**New type in `src/types.ts`:**
```typescript
export interface ContainingSymbol {
  name: string;
  kind: SymbolKind;       // reuses existing SymbolKind union from types.ts
  start_line: number;
  end_line: number;
  in_degree: number;      // 0 if unknown, never undefined
}
// Add optional field to existing TextMatch:
//   containing_symbol?: ContainingSymbol;
```

**Changes:**
- Add `ContainingSymbol` interface and optional field on `TextMatch`
- Add `ranked?: boolean` to `SearchTextOptions` and tool schema
- New `classifyHitsWithSymbols(matches, index, bm25Idx): TextMatch[]`:
  - Phase 2: binary search symbols by line range, mtime guard for stale index
  - Phase 3: dedup max 2 hits per function (diverse content)
  - Phase 4: score = `in_degree × 0.5 + label_bonus + match_count × 0.3`
- Guard: `if (options.ranked && matches.length > 0)` before compact/group-by-file branch
- Pipeline timeout reuses `SEARCH_TIMEOUT_MS`
- Cap stat() calls at 50 unique files

**LOC:** +133

### Edge Cases

| Feature | Edge Case | Handling |
|---------|-----------|----------|
| F1 | Misspelled tool name in describe_tools | Return in `not_found` array, partial results for valid names |
| F1 | 40x disable() at startup → 40 notifications | SDK batches; verify single consolidated notification |
| F3 | Read on non-code file (.env, .json) | Extension filter — only code files blocked |
| F3 | codesift not on PATH | Hook fails silently, Read proceeds normally (exit 0 fallback) |
| F3 | Bash bypass (cat/head) | Documented limitation, not solved |
| F4 | Cascade + codebase_retrieval double-budget | Skip cascade for codebase_retrieval |
| F4 | LLM specified detail_level explicitly | Skip cascade — respect explicit params |
| F5 | Stale index (file edited since last index) | mtime check, skip classification for stale files |
| F5 | 5 hits in same 300-line function | Keep max 2 with most diverse content |
| F5 | Regex query as BM25 term | Use raw query for grep, extract keywords for ranking |

## Acceptance Criteria

**Must have:**
1. F1: `discover_tools` + `describe_tools` return correct params for all 61 tools
2. F1: Non-core tools invisible in ListTools but callable by name
3. F2: `formatTable` produces aligned columns with header + separator + data rows
4. F3: `precheck-read` exits 2 with redirect for .ts files > 200 lines, exits 0 for small/non-code files
5. F3: `postindex-file` calls index_file after Edit/Write on code files
6. F3: `setup claude --hooks` is idempotent (no duplicate entries on re-run)
7. F4: Response > 15K chars auto-cascades to compact format
8. F4: Cascade skipped when `detail_level` or `token_budget` explicitly set
9. F5: `search_text(ranked=true)` returns hits with `containing_symbol` populated
10. F5: Dedup keeps max 2 hits per function, sorted by score descending
11. F5: Stale-index files gracefully fall back to unclassified hits
12. All: 0 test regressions (544 passing tests baseline)

**Should have:**
1. F1: `describe_tools(reveal=true)` enables tools in ListTools
2. F4: `[compact]` / `[counts]` annotation machine-readable
3. F5: `containing_symbol` metadata visible in formatted output

## Out of Scope

- `execute_tool` wrapper (rejected — tools callable directly)
- Full TOON serializer (marginal gain over existing formatters)
- PreToolUse for Cursor/Codex (Claude Code hooks only)
- Bash bypass mitigation for hooks (document only)
- LLM-generated summaries in cascade (non-deterministic)
- Auto-enable tools when discover_tools finds them (too aggressive)

## Open Questions

None — all resolved during design dialogue.
