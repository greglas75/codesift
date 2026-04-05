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

## Tool Discovery (NEW — agents read this)

Non-core tools are **hidden** from ListTools (via SDK `disable()`). Only ~13 core tools are visible.
To find hidden tools: `discover_tools(query="dead code")` → keyword search.
To get full schema: `describe_tools(names=["find_dead_code"])` → returns params with types.
To reveal in ListTools: `describe_tools(names=["find_dead_code"], reveal=true)`.

### search_text ranked mode (NEW)
`search_text(repo, query, ranked=true)` classifies each hit by its containing function, deduplicates (max 2 per function), and ranks by symbol centrality. Returns `TextMatch` with `containing_symbol` field. Saves 1-3 follow-up get_symbol calls. Takes precedence over `auto_group`.

### Progressive response shortening (NEW)
Large responses auto-cascade: >52.5K chars → compact format, >87.5K → counts only, >105K → hard truncate. Skipped when `detail_level` or `token_budget` is explicitly set. Annotation `[compact]` or `[counts]` prepended.

### CLI hooks (NEW)
`codesift setup claude --hooks` installs PreToolUse (redirect Read on large code files to CodeSift) and PostToolUse (auto index-file after Edit/Write). Hooks go to `.claude/settings.local.json`.

## Architecture

**63 MCP tools** (13 core + 50 deferred) | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection

**src/tools/** (21 files) — MCP tool handlers + search-ranker.ts (4-phase ranked pipeline)
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (10 files) — Language extractors (TS, JS, Python, Go, Rust, Prisma, MD, Astro, Conversation)
**src/storage/** (8 files) — Index persistence, embeddings, usage tracker, watcher
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (4 files) — BM25F index with centrality bonus, semantic embeddings
**src/utils/** (6 files) — Import graph, glob, walk, git validation
**src/cli/** (4 files) — CLI commands + hooks.ts (PreToolUse/PostToolUse)
**src/formatters-shortening.ts** — Compact/counts formatters for progressive cascade
**tests/** — 830+ tests (Vitest)
