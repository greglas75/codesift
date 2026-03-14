# CodeSift -- Token-efficient code intelligence for AI agents

CodeSift indexes your codebase with tree-sitter AST parsing and gives AI agents 22 search/retrieval tools via CLI or MCP server. It uses 20-33% fewer tokens than raw grep/Read workflows on typical code navigation tasks.

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

## CLI commands

### Indexing

| Command | Description |
|---------|-------------|
| `codesift index <path>` | Index a local folder |
| `codesift index-repo <url>` | Clone and index a remote git repository |
| `codesift repos` | List all indexed repositories |
| `codesift invalidate <repo>` | Clear index cache for a repository |

### Search

| Command | Description |
|---------|-------------|
| `codesift search <repo> <query>` | Full-text search across all files |
| `codesift symbols <repo> <query>` | Search symbols by name/signature |

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

### Graph & analysis

| Command | Description |
|---------|-------------|
| `codesift trace <repo> <name>` | Trace call chain (callers/callees) |
| `codesift impact <repo> --since <ref>` | Blast radius of git changes |
| `codesift context <repo> <query>` | Assemble relevant code context |
| `codesift knowledge-map <repo>` | Module dependency map |

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

## When to use CodeSift vs grep

| Task | Best tool | Why |
|------|-----------|-----|
| Find text in files | `codesift search` | 33% fewer tokens, BM25 ranking |
| Find function by name | `codesift symbols` | Returns signature + body in 1 call |
| File structure | `codesift tree` | 20% fewer tokens, symbol counts |
| "How does X work?" | `codesift retrieve` (semantic) | 20% better quality on concept queries |
| Find ALL occurrences | `grep -rn` | Exhaustive, no top_k cap |
| Count matches | `grep -c` | Simple exact count |
| Call chain tracing | `grep -rn "fn("` | CodeSift trace is being rewritten |

## MCP server

CodeSift runs as an [MCP](https://modelcontextprotocol.io) server, exposing all 22 tools to AI agents like Claude.

### Claude Code (CLI)

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "codesift-mcp"
    }
  }
}
```

Or from source:

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

## Semantic search

Semantic search uses embeddings to answer concept queries like "how does authentication work?" that keyword search misses.

### Setup

Set **one** of these environment variables:

| Variable | Provider | Model |
|----------|----------|-------|
| `CODESIFT_VOYAGE_API_KEY` | [Voyage AI](https://voyageai.com/) | `voyage-code-3` |
| `CODESIFT_OPENAI_API_KEY` | [OpenAI](https://openai.com/) | `text-embedding-3-small` |
| `CODESIFT_OLLAMA_URL` | [Ollama](https://ollama.com/) (local) | `nomic-embed-text` |

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

### MCP example

```json
{
  "mcpServers": {
    "codesift": {
      "command": "codesift-mcp",
      "env": {
        "CODESIFT_OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Configuration

All configuration is via environment variables.

| Variable | Description | Default |
|----------|-------------|---------|
| `CODESIFT_DATA_DIR` | Storage directory for indexes | `~/.codesift` |
| `CODESIFT_WATCH_DEBOUNCE_MS` | File watcher debounce interval | `500` |
| `CODESIFT_DEFAULT_TOKEN_BUDGET` | Default token budget for retrieval | `8000` |
| `CODESIFT_DEFAULT_TOP_K` | Default max results for search | `20` |

## How it works

1. **Indexing** -- Tree-sitter WASM grammars parse source files into ASTs. Symbol extraction produces functions, classes, methods, types, constants, etc. with signatures, docstrings, and source code.

2. **BM25F search** -- Symbols are tokenized (camelCase/snake_case splitting) and indexed with field-weighted BM25 scoring. Name matches rank 3x higher than body matches.

3. **Semantic search** (optional) -- Source code is chunked and embedded via the configured provider. Queries are embedded at search time and ranked by cosine similarity. Multi-sub-query decomposition with Reciprocal Rank Fusion (RRF, k=60).

4. **Hybrid search** -- Combines semantic embedding similarity with BM25 text matches via RRF, getting the best of both keyword and concept search.

5. **File watcher** -- chokidar watches indexed folders for changes. Modified files are re-parsed and the index is updated incrementally.

## Supported languages

TypeScript, JavaScript (JSX/TSX), Python, Go, Rust, Java, Ruby, PHP, Markdown, CSS, Prisma.

## Development

```bash
git clone https://github.com/greglas/codesift-mcp.git
cd codesift-mcp
npm install
npm run download-wasm   # Download tree-sitter WASM grammars
npm run build           # TypeScript compilation
npm test                # Run tests (Vitest)
npm run test:coverage   # Coverage report
```

## License

MIT
