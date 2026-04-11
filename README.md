# CodeSift -- Token-efficient code intelligence for AI agents

CodeSift indexes your codebase with tree-sitter AST parsing and gives AI agents 82 search, retrieval, and analysis tools via CLI or MCP server. It uses 61-95% fewer tokens than raw grep/Read workflows on typical code navigation tasks.

**Works with:** Claude Code, Cursor, Codex, Gemini CLI, Zed, Aider, Continue — any MCP client.

## Install

```bash
npm install -g codesift-mcp
```

Then configure your AI coding tool (pick one, or use `all`):

```bash
codesift setup claude    # Claude Code — config + rules + hooks
codesift setup codex     # Codex CLI — config + AGENTS.md rules
codesift setup cursor    # Cursor IDE — config + .cursor/rules
codesift setup gemini    # Gemini CLI — config + GEMINI.md rules
codesift setup all       # All platforms at once
```

**What `setup` installs (all by default):**

| Component | What it does | Opt-out |
|-----------|-------------|---------|
| **MCP config** | Registers codesift-mcp server | (required) |
| **Rules file** | Tool mapping, hints, ALWAYS/NEVER rules for your AI agent | `--no-rules` |
| **Hooks** (Claude only) | Auto-index after Edit/Write, redirect large Read to CodeSift | `--no-hooks` |

Additionally, every MCP client receives ~800 tokens of compact guidance automatically via the MCP `instructions` field — zero setup needed.

## Update

```bash
npm update -g codesift-mcp
codesift setup all              # Updates rules files to latest version
codesift setup all --force      # Force-update even if you modified rules
```

If you use `npx -y codesift-mcp` (the default), each platform automatically picks up the latest published version on next session start. Re-run `setup` to update rules files to the latest version.

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

### Combo benchmark (real-world tool sequences)

772 real tasks from usage.jsonl — exact query sequences agents used across 33+ repos. Native (grep/find/read) vs CodeSift.

| Sequence | Runs | Tok native | Tok Sift | Delta | Wins |
|----------|------|-----------|----------|-------|------|
| pat→st→pat→st (4-gram) | 37 | 377,258 | 36,758 | **-90%** | 28/37 |
| pat→st→pat | 39 | 186,436 | 20,500 | **-89%** | 31/39 |
| st→pat→st→pat | 35 | 307,490 | 35,905 | **-88%** | 25/35 |
| ss→st | 78 | 202,837 | 36,408 | **-82%** | 35/78 |
| st→pat→st | 40 | 250,240 | 44,424 | **-82%** | 27/40 |
| st→tree→st | 28 | 262,703 | 61,093 | **-77%** | 22/28 |
| tree→st | 57 | 380,324 | 133,578 | **-65%** | 44/57 |
| **AGGREGATE** | **772** | **5,130,240** | **1,994,825** | **-61%** | **542/772** |

### Per-tool (single-tool benchmark)

| Tool | Tok native | Tok Sift | Delta |
|------|-----------|----------|-------|
| search_text vs rg | 1,015,245 | 49,718 | **-95%** |
| search_symbols vs rg | 192,486 | 34,186 | **-82%** |
| get_file_outline vs Read | 91,796 | 58,229 | **-37%** |

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
| **Progressive cascade** | >15K tok → compact format, >25K → counts only, >30K → truncate | Auto-adjusting response size |
| **Tool visibility** | Non-core tools hidden via MCP `disable()`, discoverable on demand | ~10K fewer tokens in system prompt |
| **MCP instructions** | ~800 tok of agent guidance sent automatically to every client | Zero-setup onboarding |
| **Ranked search** | `search_text(ranked=true)` classifies hits by containing symbol, deduplicates | Saves 1-3 follow-up calls |
| **PreToolUse hooks** | Redirect large-file Read to CodeSift outline/search | Prevents 5K+ token file dumps |
| **PostToolUse hooks** | Auto-reindex after Edit/Write | Always-fresh index |
| **Sequential hints** | Prepended hints (H1-H9) suggest batching after 3+ consecutive calls | Guides agents toward efficient usage |

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
| `codesift trace-route <repo> <path>` | Trace HTTP route → handler → service → DB calls (NestJS/Next.js/Express/Ktor/Spring Boot Kotlin) |
| `codesift communities <repo>` | Louvain community detection — discover code clusters from import graph |

### Code analysis

| Command | Description |
|---------|-------------|
| `codesift dead-code <repo>` | Find exported symbols with zero external references |
| `codesift complexity <repo>` | Cyclomatic complexity + nesting depth per function |
| `codesift clones <repo>` | Copy-paste detection (hash bucketing + line similarity) |
| `codesift hotspots <repo>` | Git churn x complexity = risk-ranked file list |
| `codesift patterns <repo> <pattern>` | Structural anti-pattern search (33 built-in + custom regex) |

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

## MCP tools (88 total — 42 core + 46 discoverable)

When running as an MCP server, CodeSift exposes 42 core tools directly. The remaining 46 niche tools are discoverable via `discover_tools` and `describe_tools`.

| Category | Tools |
|----------|-------|
| **Indexing** | `index_folder` (mtime skip, dirty propagation), `index_repo`, `index_file` (single-file reindex, 9ms), `list_repos`, `invalidate_cache` |
| **Search** | `search_symbols` (detail_level: compact/standard/full, token_budget, kind filter incl. `component`/`hook`), `search_text` (auto_group, group_by_file, ranked) |
| **Outline** | `get_file_tree`, `get_file_outline`, `get_repo_outline`, `suggest_queries` (React-aware: suggests component/hook queries when detected) |
| **Symbol retrieval** | `get_symbol`, `get_symbols`, `find_and_show`, `get_context_bundle` (React enrichment: hooks_used, child_components, parent_components, wrapper pattern) |
| **References & graph** | `find_references` (LSP-enhanced), `trace_call_chain` (JSX-aware: `<Component>` = call edge; `filter_react_hooks` option), `impact_analysis`, `trace_route` (HTTP route → handler → DB — NestJS/Next.js/Express/Ktor/Spring Boot/Yii2/Laravel) |
| **React** | `trace_component_tree` (BFS JSX composition tree with Mermaid output), `analyze_hooks` (hook inventory, Rule of Hooks violations, custom hook composition, usage summary) |
| **LSP bridge** | `go_to_definition` (LSP + index fallback), `get_type_info` (hover), `rename_symbol` (cross-file type-safe rename) |
| **Context & knowledge** | `assemble_context` (level: L0/L1/L2/L3), `get_knowledge_map`, `detect_communities` (Louvain) |
| **Conversation search** | `index_conversations`, `search_conversations`, `find_conversations_for_symbol` |
| **Diff** | `diff_outline`, `changed_symbols` |
| **Batch retrieval** | `codebase_retrieval` (batch multiple sub-queries with shared token budget, incl. `type: "conversation"`) |
| **Security** | `scan_secrets` (AST-aware secret detection, ~1,100 rules, masked output) |
| **PHP / Yii2** | `resolve_php_namespace` (PSR-4 FQCN→file via composer.json), `analyze_activerecord` (model schema: tableName, relations, rules, behaviors), `trace_php_event` (event trigger→listener chain), `find_php_views` (render→view file mapping), `resolve_php_service` (Yii::\$app→concrete class via config), `php_security_scan` (compound: SQL injection, XSS, eval, exec, unserialize — parallel checks), `php_project_audit` (meta-tool: security + ActiveRecord + health score) |
| **Analysis** | `find_dead_code` (framework-aware incl. React/Next.js route entry points), `analyze_complexity` (React: hook_count, state_count, effect_count, jsx_depth), `find_clones`, `analyze_hotspots`, `search_patterns` (33 built-in: JS/TS ×9, React ×14, Kotlin ×6, PHP ×4), `list_patterns`, `frequency_analysis` (AST subtree clustering), `find_perf_hotspots` (6 perf anti-patterns: unbounded queries, sync I/O, N+1 loops, unbounded parallel, missing pagination, expensive recompute), `explain_query` (Prisma→SQL with EXPLAIN ANALYZE), `audit_scan` (5-gate composite: dead code + clones + patterns + complexity + hotspots) |
| **Architecture** | `classify_roles` (symbol role classification via call graph), `check_boundaries` (architecture boundary enforcement), `ast_query` (structural grep via tree-sitter), `fan_in_fan_out` (import graph coupling: most-imported, most-dependent, hub files, coupling score 0-100), `co_change_analysis` (temporal coupling from git history: Jaccard similarity, cluster detection), `architecture_summary` (one-call composite: stack + communities + coupling + circular deps + LOC + entry points, Mermaid output) |
| **Cross-repo** | `cross_repo_search`, `cross_repo_refs` |
| **Report** | `generate_report` (standalone HTML with complexity, dead code, hotspots, communities) |
| **Tool discovery** | `discover_tools` (keyword search across hidden tools), `describe_tools` (full schema on demand, optional `reveal`) |
| **Meta** | `index_status` (check if repo is indexed: file/symbol counts, language breakdown, text_stub languages), `analyze_project` (stack + conventions detection), `get_extractor_versions` (parser language support) |
| **Utility** | `generate_claude_md` (architecture + behavioral guidance), `usage_stats` (with token savings tracking) |

### Conversation search

Search past Claude Code conversation history — the decisions, rationale, and debugging sessions that shaped your code.

```bash
# Index conversations for current project (auto-detected from cwd)
# Also runs automatically at startup via auto-discovery
index_conversations()

# Index a specific project's conversations
index_conversations(project_path="/Users/me/.claude/projects/-Users-me-DEV-my-project")

# Search past conversations
search_conversations(query="auth middleware bug", limit=5)

# Find conversations that discussed a specific code symbol
find_conversations_for_symbol(symbol_name="processPayment", repo="local/my-project")

# In codebase_retrieval batch queries
codebase_retrieval(repo, queries=[
  {"type": "semantic", "query": "how does auth work"},
  {"type": "conversation", "query": "why we chose Redis over Postgres cache"}
])
```

**Features:**
- Auto-discovery at startup (zero config)
- Session-end hook for immediate re-indexing
- Noise filtering: tool_result dumps stripped, tool_use truncated, images → `[image]`
- Compaction-aware: skips summary injections, indexes last summary as meta-doc
- Cross-reference: link code symbols to the conversations that discussed them

### Secret scanning

Detect hardcoded secrets (API keys, JWT tokens, passwords, connection strings) in your indexed codebase. Uses ~1,100 detection rules from TruffleHog via `@sanity-labs/secret-scan`, with CodeSift's tree-sitter AST for false-positive reduction.

```bash
# Scan entire repo for secrets
scan_secrets(repo="local/my-project")

# Filter by severity
scan_secrets(repo="local/my-project", severity="critical")

# Only high-confidence findings, including test files
scan_secrets(repo="local/my-project", min_confidence="high", exclude_tests=false)

# Scope to specific directory
scan_secrets(repo="local/my-project", file_pattern="src/config/**")
```

**Features:**
- Eager scanning on file change — results are cached and instant on query
- AST-aware confidence: test files, docs, placeholder variables auto-demoted to `low`
- Masked output — secrets shown as `sk-p***hijk`, raw values never in cache or logs
- Inline allowlist — add `// codesift:allow-secret` to suppress a finding
- Config files indexed — `.env`, `.yaml`, `.toml`, `.json`, `.ini`, `.properties` scanned
- Severity mapping: cloud keys (AWS, GCP) = critical, API keys (OpenAI, GitHub) = high
- Inline warnings in `index_file` responses when secrets detected

### PHP / Yii2 support

Full PHP code intelligence with first-on-market Yii2 framework awareness. No other general-purpose MCP tool provides static Yii2 intelligence.

**Symbol extraction** (tree-sitter-based):
- Namespaces, classes, interfaces, traits, enums (PHP 8.1), functions, methods, properties, constants
- PHPDoc extraction, signature extraction with type hints and return types
- PHPUnit test detection: `TestCase` subclass = `test_suite`, `test*` methods = `test_case`, `setUp`/`tearDown` = `test_hook`

**Yii2 framework awareness:**
- Convention routing: `trace_route("site/index")` resolves to `SiteController::actionIndex()` (incl. module nesting)
- `analyze_project` detects Yii2 via `composer.json` and extracts: controllers, models, modules, widgets, behaviors, components, assets, config files
- 7 PHP-specific tools: namespace resolution (PSR-4), ActiveRecord schema extraction (relations, rules, behaviors), event/listener tracing, view mapping, service locator resolution, security scanning, project audit

**Laravel support:**
- Route tracing via `Route::get('/path', [Controller::class, 'method'])` pattern matching
- Convention extraction: controllers, middleware, models, routes, migrations

```bash
# Trace a Yii2 route
trace_route(repo, path="site/about")

# Analyze ActiveRecord models
analyze_activerecord(repo, model_name="User")

# PHP security scan (8 parallel checks)
php_security_scan(repo)

# Resolve PSR-4 namespace to file
resolve_php_namespace(repo, class_name="App\\Models\\User")
```

**LSP bridge:** Intelephense configured for go-to-definition, find-references, type-info, and rename across PHP files.

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
| Detect hardcoded secrets | `scan_secrets` | ~1,100 rules, AST-aware, masked output, auto-cached |
| Ranked text search | `search_text(ranked=true)` | Classifies hits by function, saves follow-up get_symbol calls |
| Find hidden tools | `discover_tools` + `describe_tools` | 45 tools hidden by default — search by keyword, get full schema |
| Find ALL occurrences | `grep -rn` | Exhaustive, no top_k cap |
| Count matches | `grep -c` | Simple exact count |

## Built-in anti-patterns (33 total)

The `patterns` command searches for common code quality issues across your codebase:

| Pattern | What it finds |
|---------|---------------|
| `empty-catch` | `catch (e) {}` — swallowed errors |
| `any-type` | `: any` or `as any` — lost type safety |
| `console-log` | `console.log/debug/info` in production code |
| `await-in-loop` | Sequential `await` inside `for` loops |
| `no-error-type` | Catch without `instanceof Error` narrowing |
| `toctou` | Read-then-write without atomic operation |
| `unbounded-findmany` | Prisma `findMany` without `take` limit |
| `scaffolding` | TODO/FIXME/HACK markers, Phase/Step stubs, "not implemented" throws |
| `runblocking-in-coroutine` | Kotlin: `runBlocking` inside suspend function — deadlock risk |
| `globalscope-launch` | Kotlin: `GlobalScope.launch/async` — lifecycle leak |
| `data-class-mutable` | Kotlin: `data class` with `var` property — breaks hashCode contract |
| `lateinit-no-check` | Kotlin: `lateinit var` without `isInitialized` check |
| `empty-when-branch` | Kotlin: empty `when` branch — swallowed case |
| `mutable-shared-state` | Kotlin: mutable `var` inside `object`/`companion` — thread-unsafe |
| **React (14)** | |
| `useEffect-no-cleanup` | useEffect without cleanup return — memory leak |
| `hook-in-condition` | Hook inside if/for/while/switch — Rule of Hooks violation |
| `useEffect-async` | async function directly in useEffect |
| `useEffect-object-dep` | Object/array literal in dep array — infinite re-render |
| `missing-display-name` | React.memo/forwardRef without displayName |
| `index-as-key` | Array index used as React key — incorrect reconciliation |
| `inline-handler` | Arrow function in JSX event handler — memoization killer |
| `conditional-render-hook` | Hook called after early return — Rule of Hooks violation |
| `dangerously-set-html` | dangerouslySetInnerHTML — XSS risk |
| `direct-dom-access` | document.getElementById/querySelector — use useRef |
| `unstable-default-value` | `= []`/`= {}` default in params — new ref every render |
| `jsx-falsy-and` | `{count && <Comp/>}` renders "0" when count is 0 |
| `nested-component-def` | Component inside component — remounts every render |
| `usecallback-no-deps` | useCallback/useMemo without dep array — useless memoization |
| **PHP (7)** | |
| `sql-injection-php` | User input flowing into SQL query |
| `xss-php` | Unescaped user input echoed to output |
| `eval-php` / `exec-php` | eval/shell execution — injection risk |
| `unserialize-php` | `unserialize()` on user input |
| `unescaped-yii-view` | Yii2 view without `Html::encode()` |
| `raw-query-yii` | Yii2 createCommand with string interpolation |

Custom regex is also supported: `codesift patterns local/project "Promise<.*any>"`.

### Performance anti-patterns (`find_perf_hotspots`)

A separate tool scans for performance-specific issues with balanced-brace loop body extraction (not just regex):

| Pattern | What it finds | Severity |
|---------|---------------|----------|
| `unbounded-query` | `findMany`/`find` without `take`/`limit` | high |
| `sync-in-handler` | `readFileSync`/`execSync` in route/handler/controller files | high |
| `n-plus-one` | DB/fetch call inside `for`/`while` loop body | high |
| `unbounded-parallel` | `Promise.all(arr.map(...))` without concurrency control | medium |
| `missing-pagination` | API response from unbounded list query | medium |
| `expensive-recompute` | Same method called 2+ times in loop body (excludes common methods) | low |

```bash
# Scan all patterns
find_perf_hotspots(repo)

# Only N+1 and unbounded queries
find_perf_hotspots(repo, patterns="n-plus-one,unbounded-query")

# Scope to API directory
find_perf_hotspots(repo, file_pattern="src/api")
```

## MCP server setup

CodeSift runs as an [MCP](https://modelcontextprotocol.io) server, exposing 88 tools to AI agents (42 core + 46 discoverable). The fastest setup method is `codesift setup <platform>` which handles everything automatically. Manual configuration is also supported:

### OpenAI Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.codesift]
command = "npx"
args = ["-y", "codesift-mcp"]
tool_timeout_sec = 120
```

You can also add it manually or via the Codex CLI:

```bash
codex mcp add codesift -- npx -y codesift-mcp
```

### Claude Code

Add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "npx",
      "args": ["-y", "codesift-mcp"]
    }
  }
}
```

With semantic search (OpenAI embeddings), add the env var manually:

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

Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "npx",
      "args": ["-y", "codesift-mcp"]
    }
  }
}
```

### Gemini CLI

Add this to `~/.gemini/settings.json`, or to `.gemini/settings.json` in your project:

```json
{
  "mcpServers": {
    "codesift": {
      "command": "npx",
      "args": ["-y", "codesift-mcp"]
    }
  }
}
```

You can also use the Gemini CLI:

```bash
gemini mcp add codesift -s user npx -- -y codesift-mcp
```

### All platforms at once

```bash
codesift setup all
```

This configures Codex, Claude Code, Cursor, and Gemini CLI in one command. Safe to run multiple times — skips platforms that are already configured.

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
| `CODESIFT_SECRET_SCAN` | Enable/disable secret scanning | `true` (set `false` to disable) |

## How it works

1. **Indexing** -- Tree-sitter WASM grammars parse source files into ASTs. Symbol extraction produces functions, classes, methods, types, constants, etc. with signatures, docstrings, and source code. Filesystem mtime is stored per file for incremental skip on reindex.

2. **BM25F search** -- Symbols are tokenized (camelCase/snake_case splitting) and indexed with field-weighted BM25 scoring. Name matches rank 5x higher than body matches. Symbols in frequently-imported files get a log-scaled centrality bonus as tiebreaker.

3. **Semantic search** (optional) -- Source code is chunked and embedded via the configured provider. Queries are embedded at search time and ranked by cosine similarity. Multi-sub-query decomposition with Reciprocal Rank Fusion (RRF, k=60).

4. **Hybrid search** -- Combines semantic embedding similarity with BM25 text matches via RRF, getting the best of both keyword and concept search.

5. **File watcher** -- chokidar watches indexed folders for changes. Modified files are re-parsed and the index is updated incrementally.

6. **Response guards** -- Multiple layers prevent token waste: progressive cascade (>15K tok → compact, >25K → counts, >30K → truncate), response dedup cache (30s), in-flight request coalescing, H1-H9 sequential hints, and source truncation.

7. **Agent onboarding** -- MCP `instructions` field sends ~800 tokens of guidance (tool discovery, hints, ALWAYS/NEVER rules) to every client automatically. `codesift setup` installs full rules files per platform + Claude Code hooks for enforcement.

8. **LSP bridge** (optional) -- When a language server is installed (typescript-language-server, pylsp, gopls, rust-analyzer, kotlin-language-server, solargraph, intelephense), CodeSift uses it for type-safe `find_references`, precise `go_to_definition`, `get_type_info` via hover, and cross-file `rename_symbol`. Falls back to tree-sitter/grep when LSP is unavailable. Lazy start + 5 min idle kill — zero overhead when not used.

## Glob pattern support

File pattern parameters (`file_pattern`) support full glob syntax via [picomatch](https://github.com/micromatch/picomatch):

- `*.ts` — match by extension at any depth
- `*.{ts,tsx}` — brace expansion
- `src/**/*.service.ts` — directory globbing
- `[!.]*.ts` — character classes
- `service` — plain substring match (no glob chars)

## Supported languages

TypeScript, JavaScript (JSX/TSX), Python, Go, Rust, **Kotlin**, Java, Ruby, PHP, Markdown, CSS, Prisma, Astro.

**React/JSX/TSX** has first-class support: `component` and `hook` SymbolKind values, JSX-aware call graph (all graph tools see `<Component>` usage as call edges), 14 React anti-patterns, `trace_component_tree` (BFS JSX composition tree), `analyze_hooks` (hook inventory + Rule of Hooks violation detection), React complexity metrics (hook_count, state_count, effect_count, jsx_depth), enriched `get_context_bundle` (hooks_used, child_components, parent_components, wrapper pattern), `filter_react_hooks` option on `trace_call_chain`, React/Next.js/Remix route entry point detection (prevents dead code false positives), and build tool detection (Vite, CRA, webpack, Parcel, esbuild, Rspack, Rsbuild, Turbopack).

Kotlin support includes full tree-sitter parsing with a dedicated extractor for functions, classes (data/sealed/enum/abstract/annotation), interfaces, objects (singleton + companion), properties (val/var/const), type aliases, extension functions, suspend functions, generics, KDoc comments, and JUnit test detection (@Test, @BeforeEach, @AfterEach, @BeforeAll, @AfterAll). Route tracing supports Ktor DSL and Spring Boot Kotlin. Six Kotlin anti-patterns are built-in.
| PHP/Yii2 support | src/parser/extractors/php.ts, src/tools/php-tools.ts (7 tools), src/tools/project-tools.ts (Yii2Conventions), src/tools/route-tools.ts (findYii2Handlers, findLaravelHandlers), src/tools/pattern-tools.ts (8 PHP anti-patterns), src/tools/graph-tools.ts (PHP method call detection), src/utils/import-graph.ts (PHP require/include), src/lsp/lsp-servers.ts (Intelephense), scripts/download-wasm.ts (tree-sitter-php@0.23.12) |

## Development

```bash
git clone https://github.com/greglas75/codesift.git
cd codesift-mcp
npm install
npm run download-wasm   # Download tree-sitter WASM grammars
npm run build           # TypeScript compilation
npm test                # Run tests (Vitest, 1300+ tests)
npm run test:coverage   # Coverage report
npm run lint            # Type check (tsc --noEmit)
```

## Publishing a new version

After making changes, follow these steps to publish to npm:

```bash
# 1. Ensure clean working tree
git status              # No uncommitted changes

# 2. Build and verify
npm run build           # Must succeed with 0 errors
npm test                # Must pass (flaky ast-query tests may fail in full suite — OK if they pass individually)

# 3. Bump version (choose one)
npm version patch       # 0.2.0 → 0.2.1 (bug fixes)
npm version minor       # 0.2.0 → 0.3.0 (new features)
npm version major       # 0.2.0 → 1.0.0 (breaking changes)
# This creates a git commit + tag automatically

# 4. Publish to npm
npm publish --ignore-scripts
# npm will open browser for WebAuthn/Keychain authentication
# Press Enter, confirm in browser, done

# 5. Push to GitHub (commit + tag)
git push && git push --tags
```

### What gets published

The `files` field in `package.json` controls what ships:
- `dist/` — compiled JavaScript
- `rules/` — platform-specific agent rules (codesift.md, codesift.mdc, codex.md, gemini.md)
- `src/parser/languages/` — tree-sitter WASM grammars
- `README.md`, `LICENSE`

### After publishing

Users update with:
```bash
npm update -g codesift-mcp        # Update package
codesift setup all                 # Update rules files to latest version
```

If using `npx -y codesift-mcp` (the default in MCP config), the latest version is picked up automatically on next session start.

### Checklist before publishing

- [ ] `npm run build` — 0 TypeScript errors
- [ ] `npm test` — 1300+ tests pass
- [ ] `rules/codesift.md` updated if hints or tools changed
- [ ] `src/instructions.ts` updated if rules changed (compact version)
- [ ] `README.md` updated if features added
- [ ] `CLAUDE.md` updated if architecture changed
- [ ] Version bumped via `npm version`
- [ ] Changes committed and pushed to GitHub

## License

BSL-1.1

<!-- Evidence Map
| Section | Source file(s) |
|---------|---------------|
| Tool count (66) | src/register-tools.ts (64 in TOOL_DEFINITIONS + discover_tools + describe_tools) |
| Quick install | package.json:bin (line 8-11) |
| Quick start | src/cli/commands.ts |
| Benchmark | benchmarks/ directory, previously measured |
| Performance features | src/tools/index-tools.ts (mtime), src/tools/search-tools.ts (detail_level, token_budget), src/search/bm25.ts (centrality), src/server-helpers.ts (cache, dedup, guards) |
| CLI commands | src/cli/commands.ts:1-515 |
| MCP tools | src/register-tools.ts (all tool definitions) |
| Anti-patterns | src/tools/pattern-tools.ts |
| MCP setup | manual configs verified |
| Semantic search | src/search/semantic.ts, src/config.ts:40-47 |
| Configuration | src/config.ts:36-72 |
| How it works | src/search/bm25.ts, src/parser/, src/storage/watcher.ts, src/server-helpers.ts |
| Glob support | src/utils/glob.ts (picomatch) |
| LSP bridge | src/lsp/lsp-client.ts, src/lsp/lsp-manager.ts, src/lsp/lsp-servers.ts, src/lsp/lsp-tools.ts |
| Secret scanning | src/tools/secret-tools.ts, @sanity-labs/secret-scan (package.json) |
| Languages | src/parser/parser-manager.ts, src/parser/extractors/ (incl. kotlin.ts) |
| Kotlin support | kotlin.ts, graph-tools KEYWORD_SET, complexity when/?.let, test-file Test.kt, lsp-tools .kt, import-graph FQN, route-tools Ktor/Spring, pattern-tools 6 anti-patterns |
| PHP/Yii2 support | src/parser/extractors/php.ts, src/tools/php-tools.ts (7 tools), src/tools/project-tools.ts (Yii2Conventions), src/tools/route-tools.ts (findYii2Handlers, findLaravelHandlers), src/tools/pattern-tools.ts (8 PHP anti-patterns), src/tools/graph-tools.ts (PHP method call detection), src/utils/import-graph.ts (PHP require/include), src/lsp/lsp-servers.ts (Intelephense), scripts/download-wasm.ts (tree-sitter-php@0.23.12) |
| Development | package.json:scripts (line 19-28) |
| Git URL | package.json:repository (line 62-64) |
-->
