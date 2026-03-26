# CodeSift -- Token-efficient code intelligence for AI agents

CodeSift indexes your codebase with tree-sitter AST parsing and gives AI agents 39 search, retrieval, and analysis tools via CLI or MCP server. It uses 20-33% fewer tokens than raw grep/Read workflows on typical code navigation tasks.

## Quick install

```bash
npm install -g codesift-mcp
```

## Quick start

```bash
# Index a project
codesift index /path/to/project

# Search for a function
codesift symbols local/my-project "createUser" --kind function --include-source

# Semantic search (requires embedding provider)
codesift retrieve local/my-project \
  --queries '[{"type":"semantic","query":"how does caching work?"}]'
```

## Benchmark results

Measured on a real 4,127-file TypeScript codebase (70 tasks, CodeSift CLI vs Bash grep/Read).

| Category | CodeSift | Bash grep | Delta |
|----------|----------|-----------|-------|
| Text Search | 48,930 tok | 72,993 tok | **-33%** |
| Symbol Search | 63,829 tok | 60,282 tok | +6% |
| File Structure | 36,580 tok | 45,489 tok | **-20%** |
| Code Retrieval | 57,703 tok | 60,482 tok | **-5%** |
| Relationships | 52,312 tok | 60,810 tok | **-14%** |
| Semantic Search | 7.8/10 quality | 6.5/10 | **+20% quality** |

CodeSift wins 4 of 6 categories. Symbol search is at parity (verbose output, being optimized). Relationship tracing is being rewritten for AST-level accuracy.

## Performance features

| Feature | Description | Impact |
|---------|-------------|--------|
| **mtime-based incremental indexing** | Skip files with unchanged mtime on reindex | 5.6x faster reindex (57s → 10s on 778-file repo) |
| **index_file** | Re-index a single file without full repo walk | 9ms (unchanged) / 153ms (changed) vs 3-8s full folder |
| **detail_level** on search_symbols | `compact` (~15 tok/result), `standard`, `full` | compact is 63% fewer tokens than standard |
| **token_budget** on search_symbols | Pack results to token limit instead of guessing top_k | Precise budget control |
| **Centrality bonus** in BM25 | Symbols in frequently-imported files rank higher | Core utilities surface first in search |
| **Response dedup cache** | Identical calls within 30s return cached result | Eliminates duplicate API calls |
| **In-flight dedup** | Parallel identical requests coalesce into one | Prevents race condition duplicates |
| **Auto-grouping** | Force group_by_file when output exceeds 80K chars | Prevents 100K+ token responses |
| **Relevance-gap filtering** | Cut search results below 15% of top score | 50→21 results (cleaner output) |
| **Semantic chunking** | Chunk by symbol boundaries, not fixed lines | Functions stay intact for semantic search |
| **Token savings display** | "Saved ~X tokens ($Y)" on every response | Visible ROI per call |
| **Framework-aware dead code** | Whitelist React hooks, NestJS lifecycle, Next.js handlers | <10% false positives (was ~40%) |
| **Mermaid diagrams** | `detect_communities`, `get_knowledge_map`, `trace_route` output Mermaid | Paste-ready architecture diagrams |
| **HTML report** | `generate_report` → standalone browser report | Complexity, dead code, hotspots, communities |
| **30K token hard cap** | Truncate any response exceeding 30K tokens | Last-resort safety net |
| **Sequential hints** | Prepended hints suggest batching after 3+ consecutive calls | Guides agents toward codebase_retrieval |

## CLI commands

### Indexing

| Command | Description |
|---------|-------------|
| `codesift index <path>` | Index a local folder (mtime-based incremental — skips unchanged files) |
| `codesift index-repo <url>` | Clone and index a remote git repository |
| `codesift repos` | List all indexed repositories |
| `codesift invalidate <repo>` | Clear index cache for a repository |

### Search

| Command | Description |
|---------|-------------|
| `codesift search <repo> <query>` | Full-text search across all files |
| `codesift symbols <repo> <query>` | Search symbols by name/signature (supports `--detail compact\|standard\|full` and `--token-budget N`) |

### Outline

| Command | Description |
|---------|-------------|
| `codesift tree <repo>` | File tree with symbol counts |
| `codesift outline <repo> <file>` | Symbol outline of a single file |
| `codesift repo-outline <repo>` | High-level repository outline |

### Symbol retrieval

| Command | Description |
|---------|-------------|
| `codesift symbol <repo> <id>` | Get a single symbol by ID |
| `codesift symbols-batch <repo> <ids...>` | Get multiple symbols by ID |
| `codesift find <repo> <query>` | Find symbol and show source |
| `codesift refs <repo> <name>` | Find all references to a symbol |
| `codesift context-bundle <repo> <name>` | Symbol + imports + siblings + types used in one call |

### Graph & analysis

| Command | Description |
|---------|-------------|
| `codesift trace <repo> <name>` | Trace call chain (callers/callees). Supports `--format mermaid` for flowchart output. |
| `codesift impact <repo> --since <ref>` | Blast radius of git changes + affected tests + risk scores per file |
| `codesift context <repo> <query>` | Assemble relevant code context. Supports `--level L0\|L1\|L2\|L3` for compression. |
| `codesift knowledge-map <repo>` | Module dependency map with circular dependency detection |
| `codesift trace-route <repo> <path>` | Trace HTTP route → handler → service → DB calls (NestJS/Next.js/Express) |
| `codesift communities <repo>` | Louvain community detection — discover code clusters from import graph |

### Code analysis

| Command | Description |
|---------|-------------|
| `codesift dead-code <repo>` | Find exported symbols with zero external references |
| `codesift complexity <repo>` | Cyclomatic complexity + nesting depth per function |
| `codesift clones <repo>` | Copy-paste detection (hash bucketing + line similarity) |
| `codesift hotspots <repo>` | Git churn x complexity = risk-ranked file list |
| `codesift patterns <repo> <pattern>` | Structural anti-pattern search (9 built-in + custom regex) |

### Cross-repo

| Command | Description |
|---------|-------------|
| `codesift cross-search <query>` | Search symbols across ALL indexed repositories |
| `codesift cross-refs <name>` | Find references across ALL indexed repositories |

### Diff

| Command | Description |
|---------|-------------|
| `codesift diff <repo> --since <ref>` | Structural diff between git refs |
| `codesift changed <repo> --since <ref>` | List changed symbols between refs |

### Batch & utility

| Command | Description |
|---------|-------------|
| `codesift retrieve <repo> --queries <json>` | Batch multiple queries in one call |
| `codesift stats` | Show usage statistics |
| `codesift generate-claude-md <repo>` | Generate CLAUDE.md project summary |
| `codesift list-patterns` | List all built-in anti-pattern names |

## MCP tools (39 total)

When running as an MCP server, CodeSift exposes these tools:

| Category | Tools |
|----------|-------|
| **Indexing** | `index_folder` (mtime skip, dirty propagation), `index_repo`, `index_file` (single-file reindex, 9ms), `list_repos`, `invalidate_cache` |
| **Search** | `search_symbols` (detail_level: compact/standard/full, token_budget), `search_text` (auto_group, group_by_file) |
| **Outline** | `get_file_tree`, `get_file_outline`, `get_repo_outline`, `suggest_queries` |
| **Symbol retrieval** | `get_symbol`, `get_symbols`, `find_and_show`, `get_context_bundle` |
| **References & graph** | `find_references` (LSP-enhanced), `trace_call_chain`, `impact_analysis`, `trace_route` (HTTP route → handler → DB) |
| **LSP bridge** | `go_to_definition` (LSP + index fallback), `get_type_info` (hover), `rename_symbol` (cross-file type-safe rename) |
| **Context & knowledge** | `assemble_context` (level: L0/L1/L2/L3), `get_knowledge_map`, `detect_communities` (Louvain) |
| **Diff** | `diff_outline`, `changed_symbols` |
| **Batch retrieval** | `codebase_retrieval` (batch multiple sub-queries with shared token budget) |
| **Analysis** | `find_dead_code` (framework-aware), `analyze_complexity`, `find_clones`, `analyze_hotspots`, `search_patterns` (9 built-in incl. scaffolding), `list_patterns` |
| **Cross-repo** | `cross_repo_search`, `cross_repo_refs` |
| **Report** | `generate_report` (standalone HTML with complexity, dead code, hotspots, communities) |
| **Utility** | `generate_claude_md`, `usage_stats` (with token savings tracking) |

## When to use CodeSift vs grep

| Task | Best tool | Why |
|------|-----------|-----|
| Find text in files | `codesift search` | 33% fewer tokens, BM25 ranking |
| Find function by name | `codesift symbols` | Returns signature + body in 1 call |
| File structure | `codesift tree` | 20% fewer tokens, symbol counts |
| "How does X work?" | `codesift retrieve` (semantic) | 20% better quality on concept queries |
| Call chain tracing | `codesift trace` | AST-based caller/callee graph, Mermaid output |
| Dead code / unused exports | `codesift dead-code` | Automated scan, no manual grep needed |
| Complexity hotspots | `codesift complexity` | Cyclomatic complexity + nesting depth |
| Copy-paste detection | `codesift clones` | Hash bucketing + line similarity scoring |
| Anti-pattern search | `codesift patterns` | 9 built-in CQ patterns + custom regex |
| Explore new codebase | `codesift suggest-queries` | Instant overview: top files, kind distribution, example queries |
| Re-index after edit | `index_file` | 9ms skip / 153ms reparse vs 3-8s full folder |
| Trace HTTP route | `trace_route` | URL → handler → service → DB calls in one call |
| Discover code modules | `detect_communities` | Louvain clustering finds architectural boundaries |
| Dense context (5-10x) | `assemble_context --level L1` | Signatures only — fits 56 symbols where L0 fits 19 |
| Go to definition | `go_to_definition` | LSP-precise when available, index fallback |
| Get type info | `get_type_info` | Return types + docs via LSP hover — no file reading |
| Rename across files | `rename_symbol` | LSP type-safe rename in all files at once |
| Find ALL occurrences | `grep -rn` | Exhaustive, no top_k cap |
| Count matches | `grep -c` | Simple exact count |

## Built-in anti-patterns

The `patterns` command searches for common code quality issues across your codebase:

| Pattern | What it finds |
|---------|---------------|
| `empty-catch` | `catch (e) {}` — swallowed errors |
| `any-type` | `: any` or `as any` — lost type safety |
| `console-log` | `console.log/debug/info` in production code |
| `await-in-loop` | Sequential `await` inside `for` loops |
| `useEffect-no-cleanup` | React useEffect without cleanup return |
| `no-error-type` | Catch without `instanceof Error` narrowing |
| `toctou` | Read-then-write without atomic operation |
| `unbounded-findmany` | Prisma `findMany` without `take` limit |
| `scaffolding` | TODO/FIXME/HACK markers, Phase/Step stubs, "not implemented" throws |

Custom regex is also supported: `codesift patterns local/project "Promise<.*any>"`.

## MCP server setup

CodeSift runs as an [MCP](https://modelcontextprotocol.io) server, exposing all 39 tools to AI agents like Claude.

### Claude Code (CLI)

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "codesift-mcp"
    }
  }
}
```

With semantic search (OpenAI embeddings):

```json
{
  "mcpServers": {
    "codesift": {
      "command": "/bin/sh",
      "args": ["-c", "CODESIFT_OPENAI_API_KEY='sk-...' exec codesift-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "codesift": {
      "command": "node",
      "args": ["/path/to/codesift-mcp/dist/server.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project or global config:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "codesift-mcp"
    }
  }
}
```

## Semantic search

Semantic search uses embeddings to answer concept queries like "how does authentication work?" that keyword search misses.

### Setup

Set **one** of these environment variables:

| Variable | Provider | Model | Cost |
|----------|----------|-------|------|
| `CODESIFT_VOYAGE_API_KEY` | [Voyage AI](https://voyageai.com/) | `voyage-code-3` | Best for code |
| `CODESIFT_OPENAI_API_KEY` | [OpenAI](https://openai.com/) | `text-embedding-3-small` | ~$0.02/1M tok (~$0.21 for 44 repos) |
| `CODESIFT_OLLAMA_URL` | [Ollama](https://ollama.com/) (local) | `nomic-embed-text` | Free (local) |

### Usage

```bash
# Pure semantic search
codesift retrieve local/my-project \
  --queries '[{"type":"semantic","query":"error handling and retry logic","top_k":10}]'

# Hybrid search (semantic + BM25 text, RRF-merged)
codesift retrieve local/my-project \
  --queries '[{"type":"hybrid","query":"caching strategy","top_k":10}]'
```

Semantic and hybrid queries exclude test files by default to maximize token efficiency. To include test files, set `"exclude_tests": false` in the sub-query or pass `--exclude-tests=false` on the CLI.

## Configuration

All configuration is via environment variables.

| Variable | Description | Default |
|----------|-------------|---------|
| `CODESIFT_DATA_DIR` | Storage directory for indexes | `~/.codesift` |
| `CODESIFT_WATCH_DEBOUNCE_MS` | File watcher debounce interval | `500` |
| `CODESIFT_DEFAULT_TOKEN_BUDGET` | Default token budget for retrieval | `8000` |
| `CODESIFT_DEFAULT_TOP_K` | Default max results for search | `50` |
| `CODESIFT_EMBEDDING_BATCH_SIZE` | Symbols per embedding API call | `128` |

## How it works

1. **Indexing** -- Tree-sitter WASM grammars parse source files into ASTs. Symbol extraction produces functions, classes, methods, types, constants, etc. with signatures, docstrings, and source code. Filesystem mtime is stored per file for incremental skip on reindex.

2. **BM25F search** -- Symbols are tokenized (camelCase/snake_case splitting) and indexed with field-weighted BM25 scoring. Name matches rank 5x higher than body matches. Symbols in frequently-imported files get a log-scaled centrality bonus as tiebreaker.

3. **Semantic search** (optional) -- Source code is chunked and embedded via the configured provider. Queries are embedded at search time and ranked by cosine similarity. Multi-sub-query decomposition with Reciprocal Rank Fusion (RRF, k=60).

4. **Hybrid search** -- Combines semantic embedding similarity with BM25 text matches via RRF, getting the best of both keyword and concept search.

5. **File watcher** -- chokidar watches indexed folders for changes. Modified files are re-parsed and the index is updated incrementally.

6. **Response guards** -- Multiple layers prevent token waste: auto-grouping at 80K chars, 30K token hard cap, response dedup cache (30s), in-flight request coalescing, sequential call hints, and source truncation.

7. **LSP bridge** (optional) -- When a language server is installed (typescript-language-server, pylsp, gopls, rust-analyzer, solargraph, intelephense), CodeSift uses it for type-safe `find_references`, precise `go_to_definition`, `get_type_info` via hover, and cross-file `rename_symbol`. Falls back to tree-sitter/grep when LSP is unavailable. Lazy start + 5 min idle kill — zero overhead when not used.

## Glob pattern support

File pattern parameters (`file_pattern`) support full glob syntax via [picomatch](https://github.com/micromatch/picomatch):

- `*.ts` — match by extension at any depth
- `*.{ts,tsx}` — brace expansion
- `src/**/*.service.ts` — directory globbing
- `[!.]*.ts` — character classes
- `service` — plain substring match (no glob chars)

## Supported languages

TypeScript, JavaScript (JSX/TSX), Python, Go, Rust, Java, Ruby, PHP, Markdown, CSS, Prisma, Astro.

## Development

```bash
git clone https://github.com/greglas75/codesift.git
cd codesift-mcp
npm install
npm run download-wasm   # Download tree-sitter WASM grammars
npm run build           # TypeScript compilation
npm test                # Run tests (Vitest, 392+ tests)
npm run test:coverage   # Coverage report
npm run lint            # Type check (tsc --noEmit)
```

## License

MIT

<!-- Evidence Map
| Section | Source file(s) |
|---------|---------------|
| Tool count (39) | src/register-tools.ts (grep 'name: "' count) |
| Quick install | package.json:bin (line 8-11) |
| Quick start | src/cli/commands.ts |
| Benchmark | benchmarks/ directory, previously measured |
| Performance features | src/tools/index-tools.ts (mtime), src/tools/search-tools.ts (detail_level, token_budget), src/search/bm25.ts (centrality), src/server-helpers.ts (cache, dedup, guards) |
| CLI commands | src/cli/commands.ts:1-403 |
| MCP tools | src/register-tools.ts (all tool definitions) |
| Anti-patterns | src/tools/pattern-tools.ts |
| MCP setup | ~/.claude/.mcp.json (verified working config) |
| Semantic search | src/search/semantic.ts, src/config.ts:40-47 |
| Configuration | src/config.ts:36-72 |
| How it works | src/search/bm25.ts, src/parser/, src/storage/watcher.ts, src/server-helpers.ts |
| Glob support | src/utils/glob.ts (picomatch) |
| LSP bridge | src/lsp/lsp-client.ts, src/lsp/lsp-manager.ts, src/lsp/lsp-servers.ts, src/lsp/lsp-tools.ts |
| Languages | src/parser/parser-manager.ts, src/parser/extractors/ |
| Development | package.json:scripts (line 19-28) |
| Git URL | package.json:repository (line 62-64) |
-->
