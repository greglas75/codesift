# CodeSift MCP

MCP server for code intelligence — 21 tools for symbol search, call graph analysis, and semantic code retrieval.

Built with [web-tree-sitter](https://github.com/nicolo-ribaudo/nicolo-tree-sitter/tree/main/packages/web-tree-sitter) (WASM) for multi-language AST parsing and BM25F + optional embedding-based semantic search.

## Features

- **21 MCP tools** for code navigation, search, and analysis
- **Multi-language** — TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, PHP, Markdown, CSS
- **BM25F search** with field weights (name, signature, docstring, body)
- **Semantic search** (optional) — Voyage Code 3, OpenAI, or Ollama embeddings with hybrid RRF ranking
- **Incremental indexing** with file watcher (chokidar)
- **Batch retrieval** — 10 sub-query types in a single `codebase_retrieval` call

## Installation

### From npm

```bash
npm install -g codesift-mcp
```

### From source

```bash
git clone https://github.com/greglas/codesift-mcp.git
cd codesift-mcp
npm install
npm run download-wasm
npm run build
```

## Setup

### Claude Code (CLI)

Add to `~/.claude.json`:

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

Or if installed globally:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "codesift-mcp"
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

## Configuration

All configuration is via environment variables. Set them in your MCP server config's `env` block.

| Variable | Description | Default |
|----------|-------------|---------|
| `CODESIFT_DATA_DIR` | Storage directory for indexes | `~/.codesift` |
| `CODESIFT_WATCH_DEBOUNCE_MS` | File watcher debounce interval | `500` |
| `CODESIFT_DEFAULT_TOKEN_BUDGET` | Default token budget for retrieval | `8000` |
| `CODESIFT_DEFAULT_TOP_K` | Default max results for search | `20` |

### Semantic search (optional)

Set **one** of these to enable embedding-based search:

| Variable | Provider |
|----------|----------|
| `CODESIFT_VOYAGE_API_KEY` | [Voyage AI](https://voyageai.com/) — `voyage-code-3` model |
| `CODESIFT_OPENAI_API_KEY` | [OpenAI](https://openai.com/) — `text-embedding-3-small` model |
| `CODESIFT_OLLAMA_URL` | [Ollama](https://ollama.com/) local server — `nomic-embed-text` model |

Example with semantic search enabled:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "node",
      "args": ["/path/to/codesift-mcp/dist/server.js"],
      "env": {
        "CODESIFT_OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Tools

### Indexing

| Tool | Description |
|------|-------------|
| `index_folder` | Index a local folder, extracting symbols and building the search index |
| `index_repo` | Clone and index a remote git repository |
| `list_repos` | List all indexed repositories with metadata |
| `invalidate_cache` | Clear the index cache for a repository |

### Search

| Tool | Description |
|------|-------------|
| `search_symbols` | Search for symbols (functions, classes, types) by name or signature |
| `search_text` | Full-text search across all files in a repository |

### Outline

| Tool | Description |
|------|-------------|
| `get_file_tree` | File tree with symbol counts per file |
| `get_file_outline` | Symbol outline of a single file |
| `get_repo_outline` | High-level outline of the entire repository |

### Symbol retrieval

| Tool | Description |
|------|-------------|
| `get_symbol` | Retrieve a single symbol by ID with full source code |
| `get_symbols` | Batch-retrieve multiple symbols by ID |
| `find_and_show` | Find a symbol by name, show its source and references |
| `find_references` | Find all references to a symbol across the codebase |

### Call graph

| Tool | Description |
|------|-------------|
| `trace_call_chain` | Trace callers or callees of a symbol |
| `impact_analysis` | Blast radius analysis of recent git changes |

### Context

| Tool | Description |
|------|-------------|
| `assemble_context` | Assemble focused code context within a token budget |
| `get_knowledge_map` | Module dependency map |
| `codebase_retrieval` | Batch 10+ sub-query types in a single call |

### Diff

| Tool | Description |
|------|-------------|
| `diff_outline` | Structural outline of changes between git refs |
| `changed_symbols` | Symbols added, modified, or removed between git refs |

### Generate

| Tool | Description |
|------|-------------|
| `generate_claude_md` | Generate a CLAUDE.md project summary from the index |

## Batch retrieval

`codebase_retrieval` is the most powerful tool — it batches multiple queries into one call with cross-query deduplication and token budget enforcement.

```json
{
  "repo": "local/my-project",
  "queries": [
    { "type": "file_tree", "path": "src/api/" },
    { "type": "symbols", "query": "createUser" },
    { "type": "text", "query": "TODO|FIXME", "regex": true },
    { "type": "call_chain", "symbol_name": "authenticate", "direction": "callers" },
    { "type": "semantic", "query": "error handling middleware" }
  ],
  "token_budget": 8000
}
```

Sub-query types: `symbols`, `text`, `file_tree`, `outline`, `references`, `call_chain`, `impact`, `context`, `knowledge_map`, `semantic`.

## How it works

1. **Indexing** — Tree-sitter WASM grammars parse source files into ASTs. Symbol extraction produces functions, classes, methods, types, etc. with signatures, docstrings, and source code.

2. **BM25F search** — Symbols are tokenized (camelCase/snake_case splitting) and indexed with field-weighted BM25 scoring. Name matches rank highest (3x weight).

3. **Semantic search** (optional) — Symbol text is embedded via the configured provider. Queries are embedded at search time and ranked by cosine similarity. Results are merged with BM25 via Reciprocal Rank Fusion (RRF, k=60).

4. **File watcher** — chokidar watches indexed folders for changes. Modified files are re-parsed and the index is updated incrementally (no full re-index needed).

## Development

```bash
npm install
npm run download-wasm   # Download tree-sitter WASM grammars
npm run build           # TypeScript compilation
npm test                # Run tests (Vitest)
npm run test:coverage   # Coverage report
```

## License

MIT
