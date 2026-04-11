## Tech Stack
TypeScript | Vitest | tree-sitter | BM25F + semantic search | LSP bridge

## Response Hint Codes

| Code | Meaning | Action |
|------|---------|--------|
| `H1(n)` | n matches returned | Add `group_by_file=true` |
| `H2(n,tool)` | n consecutive identical calls | Batch into one `tool` call |
| `H3(n)` | `list_repos` called n times | Reuse cached value |
| `H4` | `include_source` without `file_pattern` | Add `file_pattern` |
| `H5(path)` | Duplicate `get_file_tree` | Use cached result |
| `H6(n)` | n results without `detail_level` | Add `detail_level='compact'` |
| `H7` | `get_symbol` after `search_symbols` | Use `get_context_bundle` |
| `H8(n)` | n× `get_symbol` calls | Use `assemble_context(level='L1')` |
| `H9` | Question-word text query | Use semantic search |
| `H10` | 50+ tool calls this session | Call `get_session_snapshot` to preserve context |

## Tool Discovery (NEW — agents read this)

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only 37 core tools are visible.
To find hidden tools: `discover_tools(query="dead code")` → keyword search.
To get full schema: `describe_tools(names=["find_dead_code"])` → returns params with types.
To reveal in ListTools: `describe_tools(names=["find_dead_code"], reveal=true)`.

### search_text ranked mode (NEW)
`search_text(repo, query, ranked=true)` classifies each hit by its containing function, deduplicates (max 2 per function), and ranks by symbol centrality. Returns `TextMatch` with `containing_symbol` field. Saves 1-3 follow-up get_symbol calls. Takes precedence over `auto_group`.

### Progressive response shortening (NEW)
Large responses auto-cascade: >52.5K chars → compact format, >87.5K → counts only, >105K → hard truncate. Skipped when `detail_level` or `token_budget` is explicitly set. Annotation `[compact]` or `[counts]` prepended.

### CLI hooks (NEW)
`codesift setup claude --hooks` installs PreToolUse (redirect Read on large code files to CodeSift), PostToolUse (auto index-file after Edit/Write), and PreCompact (inject session snapshot before context compaction). Hooks go to `.claude/settings.local.json`.

## After adding/changing features — update checklist

When you add a new tool, change tool count, update benchmarks, or modify behavior:

1. **This repo (codesift-mcp):**
   - `src/instructions.ts` — update if ALWAYS/NEVER rules or hint codes changed
   - `rules/codesift.md` + `rules/codesift.mdc` + `rules/codex.md` + `rules/gemini.md` — update tool mapping
   - `CLAUDE.md` — update architecture section, tool count
   - `README.md` — update tool count, benchmarks, feature table
   - Bump version: `npm version patch/minor` → `npm publish --ignore-scripts`

2. **Website (../codesift-website):**
   - `public/llms.txt` — update features, install instructions, tool count
   - `public/llms-full.txt` — update header, add new articles
   - Components with tool count: Hero, FeatureGrid, Footer, Problem, Nav, Pricing, BaseLayout
   - Pages: index, tools/index, how-it-works, benchmarks, articles/index
   - Build + deploy: `npm run build && wrangler pages deploy dist --project-name codesift-website --commit-dirty=true`

3. **Quick grep to find all places with a number (e.g., tool count):**
   ```bash
   grep -rn "82 tools\|82 MCP" src/ ../codesift-website/src/
   ```

## Architecture

**82 MCP tools** (37 core + 45 discoverable) | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection + session-aware context

**src/tools/** (34 files) — MCP tool handlers + search-ranker.ts (4-phase ranked pipeline). Includes: coupling-tools.ts (fan_in_fan_out, co_change_analysis, shared computeCoChangePairs), perf-tools.ts (6 perf anti-pattern scanners with balanced-brace loop body extraction), architecture-tools.ts (composite: communities + coupling + circular deps + LOC + entry points), query-tools.ts (Prisma→SQL explain), status-tools.ts (index status check), audit-tools.ts (5-gate composite), review-diff-tools.ts (10-check composite), php-tools.ts (7 PHP/Yii2 tools), react-tools.ts (React component/hook conventions).
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (14 files) — Language extractors (TS, JS, **Python (full)**, Go, Rust, Prisma, MD, Astro, Conversation, Kotlin, **PHP**, **Hono**, _shared). Python extractor handles async def, @dataclass/@property/@classmethod/@staticmethod/@abstractmethod, dunder methods (tagged via meta), module constants, __all__ exports, superclasses (via extends field), dataclass fields, nested class walk, iterative walk with depth cap 200.
**src/storage/** (10 files) — Index persistence, embeddings, usage tracker, watcher, session-state (compaction survival)
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (5 files) — BM25F index with centrality bonus, semantic embeddings, chunker
**src/utils/** (8 files) — Import graph (TS/JS/PHP/Kotlin/**Python**), glob, walk, git validation; python-imports.ts (tree-sitter AST extraction) + python-import-resolver.ts (package-aware resolution with `src/` layout detection)
**src/cli/** (5 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse/PreCompact)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**src/instructions.ts** — CODESIFT_INSTRUCTIONS (~800 tok) sent via MCP instructions field
**rules/** — Platform-specific rules (claude.md, cursor.mdc, codex.md, gemini.md)
**tests/** — 1337+ tests (Vitest)
