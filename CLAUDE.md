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

## Architecture

**62 MCP tools** | tree-sitter AST + BM25F + semantic search + LSP bridge + conversation search + secret detection

**src/tools/** (19 files) — MCP tool handlers
**src/lsp/** (4 files) — LSP bridge (6 languages)
**src/parser/extractors/** (10 files) — Language extractors (TS, JS, Python, Go, Rust, Prisma, MD, Astro, Conversation)
**src/storage/** (8 files) — Index persistence, embeddings, usage tracker, watcher
**src/retrieval/** (5 files) — codebase_retrieval batch engine, semantic/hybrid search
**src/search/** (4 files) — BM25F index with centrality bonus, semantic embeddings
**src/utils/** (6 files) — Import graph, glob, walk, git validation
**src/cli/** (3 files) — CLI commands
**tests/** — 570+ tests (Vitest)
