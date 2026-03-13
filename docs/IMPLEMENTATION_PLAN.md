# CodeSift MCP — Implementation Plan

**Version:** 1.0 | **Date:** 2026-03-13
**Goal:** Full TypeScript rewrite of jcodemunch-mcp with MIT license + semantic search.
**Stack:** TypeScript + @modelcontextprotocol/sdk + web-tree-sitter (WASM) + chokidar + Vitest

---

## Overview

CodeSift delivers 21 MCP tools for code intelligence. The rewrite proceeds in 4 phases:

| Phase | Name | Output | Gate |
|-------|------|--------|------|
| 0 | Foundation | Project skeleton, MCP server, CI | `npm test` passes |
| 1 | Core Index | Parser, BM25 index, file watcher | `index_folder` works |
| 2 | Tools (21) | All 21 tools implemented | All tools respond correctly |
| 3 | Semantic Search | Embedding store, hybrid ranking | Conceptual queries work |

---

## Architecture

```
codesift-mcp/
├── src/
│   ├── server.ts                  # MCP server entry, tool registration
│   ├── config.ts                  # Env vars, defaults
│   ├── types.ts                   # Core domain types (Symbol, Index, etc.)
│   │
│   ├── parser/
│   │   ├── parser-manager.ts      # WASM init, language loading
│   │   ├── symbol-extractor.ts    # Generic symbol extraction from AST
│   │   └── extractors/
│   │       ├── typescript.ts      # TS/TSX-specific rules
│   │       ├── javascript.ts
│   │       ├── python.ts
│   │       ├── go.ts
│   │       ├── rust.ts
│   │       └── markdown.ts        # Headings as sections
│   │
│   ├── storage/
│   │   ├── index-store.ts         # Atomic JSON save/load, lock-free reads
│   │   ├── registry.ts            # Multi-repo registry
│   │   ├── watcher.ts             # chokidar file watcher → incremental updates
│   │   └── embedding-store.ts     # ndjson embedding file, batch write queue
│   │
│   ├── search/
│   │   ├── bm25.ts                # BM25 + camelCase/snake_case token splitting
│   │   ├── semantic.ts            # Embedding provider abstraction
│   │   └── hybrid.ts              # RRF combining BM25 + semantic scores
│   │
│   ├── retrieval/
│   │   └── codebase-retrieval.ts  # 10 sub-query types, token budget, dedup
│   │
│   └── tools/
│       ├── index-tools.ts         # index_folder, index_repo, list_repos, invalidate_cache
│       ├── search-tools.ts        # search_symbols, search_text
│       ├── outline-tools.ts       # get_file_tree, get_file_outline, get_repo_outline
│       ├── symbol-tools.ts        # get_symbol, get_symbols, find_and_show, find_references
│       ├── graph-tools.ts         # trace_call_chain, impact_analysis
│       ├── context-tools.ts       # assemble_context, get_knowledge_map, codebase_retrieval
│       ├── diff-tools.ts          # diff_outline, changed_symbols
│       └── generate-tools.ts     # generate_claude_md
│
├── tests/
│   ├── fixtures/                  # Sample repos for parsing tests
│   ├── parser/
│   ├── storage/
│   ├── search/
│   ├── tools/
│   └── integration/               # Full index → query round-trips
│
├── docs/
│   ├── adr/                       # Architecture Decision Records
│   └── IMPLEMENTATION_PLAN.md     # This file
│
├── scripts/
│   └── download-wasm.ts           # Download tree-sitter WASM grammars
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
└── LICENSE                        # MIT
```

---

## Phase 0: Foundation (Day 1-2)

**Goal:** Skeleton MCP server that registers all 21 tool stubs and passes CI.

### Tasks

- [ ] **P0.1** `npm init`, add dependencies (see package.json below)
- [ ] **P0.2** `tsconfig.json` — strict mode, `NodeNext` modules
- [ ] **P0.3** `vitest.config.ts` — two projects (server/WASM isolation)
- [ ] **P0.4** `src/server.ts` — MCP `StdioServerTransport`, register all 21 tool stubs
- [ ] **P0.5** `src/types.ts` — core domain types:
  - `SymbolKind`: `function | class | method | interface | type | variable | ...`
  - `Symbol`: `{ id, name, kind, file, start_line, end_line, source?, signature?, docstring? }`
  - `CodeIndex`: `{ repo, path, symbols, files, created_at, updated_at }`
  - `Registry`: `{ repos: Record<string, RepoMeta> }`
  - `SearchResult`: `{ symbol, score, matches? }`
- [ ] **P0.6** `src/config.ts` — env var parsing with defaults
- [ ] **P0.7** `.gitignore`, `LICENSE` (MIT)
- [ ] **P0.8** CI: `npm run build && npm test` (GitHub Actions workflow)
- [ ] **P0.9** `scripts/download-wasm.ts` — downloads grammars to `src/parser/languages/`

**Languages to support (WASM grammars):**
TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, PHP, Markdown, CSS, JSON

**Gate:** `npm test` runs (all stubs return `{ error: "not implemented" }`), zero TypeScript errors.

---

## Phase 1: Core Index (Day 3-6)

**Goal:** `index_folder` works end-to-end. Can parse a TypeScript repo and query symbols.

### 1.1 Parser (Day 3-4)

- [ ] **P1.1** `parser/parser-manager.ts`
  - Singleton WASM init: `await Parser.init()` once at startup
  - Language cache: `Map<string, Language>` keyed by file extension
  - `parseFile(path: string): Tree` — returns tree-sitter AST
  - `getLanguage(ext: string): Language | null` — returns null for unsupported extensions

- [ ] **P1.2** `parser/symbol-extractor.ts`
  - Generic walker: depth-first AST traversal
  - Extracts: `start_position`, `end_position`, `type` node, `name` child node
  - Returns raw `AstNode[]` for language-specific extractors to filter/enrich

- [ ] **P1.3** `parser/extractors/typescript.ts`
  - Node types to extract:
    - `function_declaration`, `arrow_function` in `lexical_declaration`
    - `class_declaration`, `method_definition`, `public_field_definition`
    - `interface_declaration`, `type_alias_declaration`
    - `export_statement` → wrap inner node
    - `describe`/`it`/`test` call_expression → `test_suite`/`test_case`
  - Signature: extract parameter list + return type from type annotation nodes
  - camelCase splitting: `getUserById` → tokens `['get', 'user', 'by', 'id']`

- [ ] **P1.4** `parser/extractors/python.ts`
  - `function_definition`, `class_definition`, `decorated_definition`
  - Docstring: first string literal in function body
  - snake_case splitting

- [ ] **P1.5** `parser/extractors/markdown.ts`
  - `atx_heading` at each level → `section` kind
  - Parent-child nesting via heading level hierarchy
  - `get_symbol` on section returns full content until next same-level heading

- [ ] **P1.6** Tests: parse 5 TypeScript fixtures, verify symbol names/locations

### 1.2 Storage (Day 4-5)

- [ ] **P1.7** `storage/index-store.ts`
  - `saveIndex(path, index)` — atomic write: `tmp.{timestamp}.json` → `rename`
  - `loadIndex(path)` — try/catch JSONDecodeError → return null
  - `saveIncremental(path, symbols)` — merge into existing index atomically
  - Thread-safe: each write uses unique tmp filename (timestamp-based, no PID/thread needed in Node.js single process)

- [ ] **P1.8** `storage/registry.ts`
  - Registry file: `~/.codesift/registry.json`
  - `registerRepo(name, path)`, `getRepo(name)`, `listRepos()`, `removeRepo(name)`
  - Atomic save (same pattern as index-store)

- [ ] **P1.9** `storage/watcher.ts`
  - `startWatcher(repoPath, onChange)` using chokidar
  - Debounce: 500ms (batch rapid file saves)
  - On change: re-parse changed file → `saveIncremental`
  - Ignore: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.codesift`

- [ ] **P1.10** Tests: atomic write concurrency test, corruption recovery test

### 1.3 BM25 Search (Day 5-6)

- [ ] **P1.11** `search/bm25.ts`
  - BM25F scoring: separate field weights (name: 3.0, signature: 2.0, docstring: 1.5, body: 1.0)
  - Tokenizer: `tokenize(text)` → split on non-alphanumeric + camelCase + snake_case
  - IDF: computed from full corpus at index build time
  - `buildIndex(symbols)` → `BM25Index`
  - `search(index, query, topK)` → `SearchResult[]`

- [ ] **P1.12** Tests: BM25 precision on known fixture (exact name, partial name, conceptual query)

### 1.4 Tools: Indexing (Day 6)

- [ ] **P1.13** `tools/index-tools.ts`
  - `index_folder(path, incremental?, include_paths?, use_ai_summaries?)` — FULL implementation
    - Walk directory tree respecting .gitignore patterns
    - Batch parse files (parallel, max 8 workers via `Promise.all` chunking)
    - Build BM25 index
    - Save to `.codesift/{hash}.index.json`
    - Register in registry
    - Start file watcher
    - Return: `{ repo, file_count, symbol_count, duration_ms }`
  - `list_repos()` — read registry, return repo list with stats
  - `invalidate_cache(repo)` — delete index files, unregister
  - `index_repo(url, ...)` — clone + index (Phase 2 — stub for now)

**Gate:** `index_folder` on PromptVault returns > 10,000 symbols in < 30s.

---

## Phase 2: All 21 Tools (Day 7-14)

**Goal:** All 21 MCP tools implemented and tested.

### Tool Implementation Priority

Implement in this order (most used first):

#### Week 2, Day 7-8: Search + Outline tools

- [ ] **P2.1** `search_symbols(repo, query, kind?, file_pattern?, include_source?, top_k?)`
  - BM25 search on symbol names
  - Optional filters: `kind` (function/class/...), `file_pattern` glob
  - `include_source=true` → include `source` field in results (default: true per jcodemunch rule)

- [ ] **P2.2** `search_text(repo, query, regex?, context_lines?, file_pattern?)`
  - Full-text search across file contents (not AST)
  - Load raw file content, line-by-line match
  - Returns: `{ file, line, content, context_before, context_after }[]`

- [ ] **P2.3** `get_file_tree(repo, path_prefix?, name_pattern?, depth?)`
  - Directory tree with symbol counts per file
  - Returns: nested `{ name, path, type, symbol_count, children? }[]`

- [ ] **P2.4** `get_file_outline(repo, file_path)`
  - All symbols in a file with signatures
  - Returns: flat list sorted by line number

- [ ] **P2.5** `get_repo_outline(repo)`
  - Per-directory symbol counts + language breakdown
  - Returns: `{ directories: [...], total_symbols, languages: {...} }`

#### Day 9-10: Symbol retrieval tools

- [ ] **P2.6** `get_symbol(repo, symbol_id)`
  - Fetch one symbol by ID: read file, extract lines `start_line..end_line`
  - Returns: full `Symbol` with `source`

- [ ] **P2.7** `get_symbols(repo, symbol_ids: string[])`
  - Batch version of get_symbol — group by file, read each file once
  - Returns: `Symbol[]`

- [ ] **P2.8** `find_and_show(repo, query, include_refs?)`
  - search_symbols + get_symbol + find_references in one call
  - Returns: `{ symbol, source, references: Reference[] }`

- [ ] **P2.9** `find_references(repo, symbol_name, file_pattern?)`
  - Text search for symbol name in all files
  - Returns: `{ file, line, context }[]`

#### Day 11-12: Graph + context tools

- [ ] **P2.10** `trace_call_chain(repo, symbol_name, direction, depth?)`
  - `direction: "callers" | "callees"`
  - Parse import graph from index (which symbols import/call which)
  - BFS up to `depth` levels
  - Returns: tree of `{ symbol, children }[]`

- [ ] **P2.11** `impact_analysis(repo, since, depth?, until?)`
  - Run `git diff --name-only {since}..{until}` to get changed files
  - For each changed file: find all symbols that import it (reverse dependency lookup)
  - Returns: `{ changed_files, affected_symbols, dependency_graph }`

- [ ] **P2.12** `assemble_context(repo, query, token_budget?)`
  - Run BM25 search, gather top results
  - Expand: include callers/callees 1 level deep
  - Token-count accumulated content, stop at budget
  - Returns: assembled code blocks with metadata

- [ ] **P2.13** `get_knowledge_map(repo, focus?, depth?)`
  - Module dependency map: which directories import which
  - Derived from import statements in index
  - Returns: `{ modules: [...], edges: [...] }` (Graphviz-compatible)

#### Day 12-13: Diff + generate tools

- [ ] **P2.14** `diff_outline(repo, since, until?)`
  - `git diff {since}..{until}` → extract changed symbols
  - Returns: `{ added: Symbol[], modified: Symbol[], deleted: Symbol[] }`

- [ ] **P2.15** `changed_symbols(repo, since, until?)`
  - Simplified diff_outline: just the symbol names grouped by file
  - Returns: `{ file: string, symbols: string[] }[]`

- [ ] **P2.16** `generate_claude_md(repo, output_path?)`
  - Analyze repo structure → generate CLAUDE.md content
  - Include: tech stack detection, key modules, architecture overview
  - Returns: markdown string

#### Day 13-14: codebase_retrieval (batch tool)

- [ ] **P2.17** `codebase_retrieval(repo, queries, token_budget?)`
  This is our **core innovation**. 10 sub-query types in one batched call.

  Sub-query dispatcher:
  ```typescript
  type SubQuery =
    | { type: "symbols"; query: string; kind?: string; top_k?: number }
    | { type: "text"; query: string; regex?: boolean; context_lines?: number }
    | { type: "file_tree"; path: string; depth?: number }
    | { type: "outline"; file_path: string }
    | { type: "references"; symbol_name: string }
    | { type: "call_chain"; symbol_name: string; direction: "callers" | "callees"; depth?: number }
    | { type: "impact"; since: string; depth?: number; until?: string }
    | { type: "context"; query: string; max_tokens?: number }
    | { type: "knowledge_map"; focus?: string }
    | { type: "semantic"; query: string; top_k?: number; file_filter?: string }  // Phase 3
  ```

  Features:
  - Cross-query deduplication (same symbol in multiple query results → included once)
  - Token budget enforcement: accumulate until budget hit, then truncate last result
  - Max 20 sub-queries per call
  - Parallel execution where queries are independent (no shared state)

**Gate:** All 21 tools respond with correct data on PromptVault repo. Integration test suite passes.

---

## Phase 3: Semantic Search (Day 15-18)

**Goal:** `{"type": "semantic", "query": "..."}` in codebase_retrieval returns meaningful results.

### Tasks

- [ ] **P3.1** `search/semantic.ts` — provider abstraction
  ```typescript
  interface EmbeddingProvider {
    embed(texts: string[]): Promise<number[][]>;  // batch
    dimensions: number;
    model: string;
  }
  ```
  Implementations: `VoyageProvider`, `OpenAIProvider`, `OllamaProvider`

- [ ] **P3.2** Symbol text builder: `buildSymbolText(symbol: Symbol): string`
  ```
  {kind} {name}
  {signature}
  {docstring}
  {body.slice(0, 200)}
  ```

- [ ] **P3.3** `storage/embedding-store.ts`
  - ndjson file: one `{"id": "...", "vec": [...]}` per line
  - `loadAll()` → `Map<string, Float32Array>`
  - `saveAll(embeddings)` — atomic write
  - Batch queue: accumulate new symbols, flush when > 128 or on idle

- [ ] **P3.4** Embedding during indexing
  - After BM25 index built: batch-embed all symbols (128 per API call)
  - Progress reporting via MCP notifications (optional)
  - Skip if no embedding provider configured

- [ ] **P3.5** `search/hybrid.ts` — RRF implementation
  ```typescript
  function hybridRank(bm25: SearchResult[], semantic: SearchResult[], k = 60): SearchResult[]
  ```

- [ ] **P3.6** Wire up `{"type": "semantic"}` sub-query in `codebase_retrieval.ts`

- [ ] **P3.7** Benchmark: 10 conceptual queries on PromptVault
  - BM25-only vs hybrid
  - Measure: precision@5, recall@5, MRR
  - Document in `benchmarks/benchmark-semantic-2026.md`

**Gate:** 10 conceptual queries return relevant results. Benchmark shows semantic improvement.

---

## Phase 4: Polish + Release (Day 19-21)

- [ ] **P4.1** `index_repo(url)` — git clone + index remote repos
- [ ] **P4.2** README with installation, configuration, tool reference
- [ ] **P4.3** npm publish prep: `files` field, `bin` entry, `prepublish` build
- [ ] **P4.4** Run `/code-audit` on all source files — fix issues
- [ ] **P4.5** Run `/test-audit` — ensure Q1-Q17 pass
- [ ] **P4.6** Benchmark vs jcodemunch: 10 tasks, token efficiency comparison
- [ ] **P4.7** GitHub repo: `greglas/codesift-mcp`, MIT license, public

---

## Dependencies

### Runtime

```json
{
  "@modelcontextprotocol/sdk": "^1.0.0",
  "web-tree-sitter": "^0.24.0",
  "chokidar": "^4.0.0",
  "ignore": "^6.0.0"
}
```

**Optional (semantic search):**
```json
{
  "voyageai": "^0.1.0",
  "openai": "^4.0.0"
}
```

### Dev

```json
{
  "typescript": "^5.7.0",
  "vitest": "^3.0.0",
  "@types/node": "^22.0.0",
  "tsx": "^4.0.0"
}
```

### No extra dependencies for:
- BM25: implement from scratch (~100 lines)
- RRF: ~20 lines
- Atomic file write: Node.js `fs.rename` (atomic on POSIX)
- File tree walk: Node.js `fs.readdir` recursive

---

## Key Design Decisions

### 1. No PID/thread in tmp filenames (unlike Python fix)

Node.js is single-process, single-thread for I/O. `fs.rename` is atomic on POSIX.
Unique tmp names: `{path}.tmp.{Date.now()}.json` — timestamp sufficient (not PID/thread).

### 2. Worker threads for CPU-bound parsing

Parsing 1000+ files is CPU-bound. Use `worker_threads` pool:
```typescript
const pool = new WorkerPool(Math.max(1, os.cpus().length - 1));
await pool.map(files, (file) => parseFile(file));
```

### 3. Incremental index updates via file watcher

File changes → re-parse changed file → merge symbols into existing index atomically.
No full re-index needed for small changes.

### 4. Symbol IDs

`{repo}:{relative_file_path}:{name}:{start_line}` — stable across re-indexes if code doesn't move.
Collision unlikely (same name at same line in same file = same symbol).

### 5. Token counting

Use character-based estimate: `tokens ≈ chars / 4`. Good enough for budget enforcement.
Exact tokenizer (tiktoken) not worth the dependency.

---

## Testing Strategy

### Unit tests (Vitest)
- Parser: 10 fixture files × 5 languages = 50 parsing tests
- BM25: precision tests (known corpus, known query → expected top result)
- Storage: atomic write, corruption recovery, concurrent write
- RRF: known BM25 + semantic scores → expected merged ranking

### Integration tests
- Full round-trip: `index_folder` → `search_symbols` → `get_symbol`
- codebase_retrieval: all 10 sub-query types on fixture repo
- File watcher: modify file → verify index updated within 1s

### Benchmark
- PromptVault repo (1183 files, 16620 symbols)
- 10 standard tasks from `benchmarks/benchmark-2026-03-05-promptvault.md`
- Compare: CodeSift BM25 vs CodeSift Hybrid vs jcodemunch vs Auggie

---

## Timeline

| Day | Phase | Milestone |
|-----|-------|-----------|
| 1-2 | 0 | Skeleton MCP server, all 21 stubs, CI green |
| 3-4 | 1.1 | Parser: TypeScript + Python WASM parsing working |
| 4-5 | 1.2 | Storage: atomic writes, registry, file watcher |
| 5-6 | 1.3-1.4 | BM25 index + `index_folder` end-to-end |
| 7-8 | 2 | Search + outline tools (8 tools) |
| 9-10 | 2 | Symbol retrieval tools (4 tools) |
| 11-12 | 2 | Graph + context tools (5 tools) |
| 12-14 | 2 | Diff, generate, codebase_retrieval (4 tools) |
| 15-18 | 3 | Semantic search end-to-end |
| 19-21 | 4 | Polish, benchmark, publish |

**Total: ~21 working days** (4-5 weeks at reasonable pace)
