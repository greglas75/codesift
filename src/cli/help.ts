// ---------------------------------------------------------------------------
// CLI help text
// ---------------------------------------------------------------------------

export const MAIN_HELP = `codesift — CLI for CodeSift code intelligence

Usage: codesift <command> [options]

Commands:
  index <path>                    Index a local folder
  index-repo <url>                Clone and index a remote git repository
  repos                           List all indexed repositories
  invalidate <repo>               Clear index cache for a repository
  index-conversations [path]      Index Claude Code conversations for the current project

  search <repo> <query>           Full-text search across all files
  symbols <repo> <query>          Search symbols by name/signature
  tree <repo>                     Get file tree with symbol counts
  outline <repo> <file>           Get symbol outline of a single file
  repo-outline <repo>             High-level repository outline

  symbol <repo> <id>              Get a single symbol by ID
  symbols-batch <repo> <ids...>   Get multiple symbols by ID

  find <repo> <query>             Find symbol and show source
  refs <repo> <name>              Find all references to a symbol
  trace <repo> <name>             Trace call chain (callers/callees)

  impact <repo> --since <ref>     Analyze blast radius of git changes
  context <repo> <query>          Assemble relevant code context
  knowledge-map <repo>            Module dependency map

  diff <repo> --since <ref>       Structural diff outline between git refs
  changed <repo> --since <ref>    List changed symbols between git refs

  retrieve <repo> --queries <json>  Batch multiple queries in one call
  stats                           Show usage statistics
  generate-claude-md <repo>       Generate CLAUDE.md project summary

  complexity <repo>               Analyze cyclomatic complexity of functions
  dead-code <repo>                Find potentially dead (unreferenced) exports
  hotspots <repo>                 Analyze git churn hotspots
  communities <repo>              Detect code clusters via community detection
  patterns <repo> --pattern <name>  Search for structural code patterns
  find-clones <repo>              Find copy-paste code clones

  setup <platform>                Configure codesift-mcp in an AI coding tool
                                  Platforms: codex, claude, cursor, gemini, all
  precheck-read                   PreToolUse hook: deny large file reads (hook handler)
  precheck-bash                   PreToolUse hook: redirect find/grep to CodeSift (hook handler)
  postindex-file                  PostToolUse hook: re-index edited files (hook handler)

Flags:
  --help            Show help for a command
  --version         Show version
  --compact         Compact JSON output (no indentation)
  --json            Full JSON output (for refs, trace commands)
  --include-source  Include source code in output (trace, impact)

Examples:
  codesift setup codex                          Set up MCP in OpenAI Codex
  codesift setup claude                         Set up MCP in Claude Code
  codesift setup gemini                         Set up MCP in Gemini CLI
  codesift setup all                            Set up MCP in all platforms
  codesift index /path/to/project
  codesift repos
  codesift search local/my-project "createUser"
  codesift symbols local/my-project "handleRequest" --kind function
  codesift tree local/my-project --path src/lib --depth 2
  codesift trace local/my-project "createRisk" --direction callers --depth 2
`;

export const COMMAND_HELP: Record<string, string> = {
  index: `codesift index <path> [options]

Index a local folder, extracting symbols and building the search index.

Arguments:
  <path>    Absolute path to the folder to index

Options:
  --incremental     Only re-index changed files
  --include-paths   Comma-separated path prefixes to include
  --no-watch        Disable file watcher for incremental updates`,

  "index-repo": `codesift index-repo <url> [options]

Clone and index a remote git repository.

Arguments:
  <url>    Git clone URL

Options:
  --branch          Branch to checkout
  --include-paths   Comma-separated path prefixes to include`,

  "index-conversations": `codesift index-conversations [project-path] [options]

Index Claude Code conversation JSONL files for the current project.

Arguments:
  [project-path]    Optional path to a Claude conversation directory. If omitted,
                    derives ~/.claude/projects/<encoded-cwd> from the current cwd.

Options:
  --quiet           Suppress JSON output (used by the Claude Stop hook)`,

  repos: `codesift repos

List all indexed repositories with metadata.`,

  invalidate: `codesift invalidate <repo>

Clear the index cache for a repository, forcing full re-index on next use.

Arguments:
  <repo>    Repository identifier (e.g. local/my-project)`,

  search: `codesift search <repo> <query> [options]

Full-text search across all files in a repository.

Arguments:
  <repo>     Repository identifier
  <query>    Search query or regex pattern

Options:
  --file-pattern     Glob pattern to filter files (e.g. "*.ts")
  --regex            Treat query as a regex pattern
  --context-lines    Number of context lines around each match (default: 2)
  --max-results      Maximum number of matching lines (default: 500)`,

  symbols: `codesift symbols <repo> <query> [options]

Search for code symbols (functions, classes, types) by name or signature.

Arguments:
  <repo>     Repository identifier
  <query>    Search query string

Options:
  --kind             Filter by symbol kind (function, class, interface, type, etc.)
  --file-pattern     Glob pattern to filter files
  --include-source   Include full source code (default: true; sets top-k default to 5)
  --top-k            Maximum number of results (default: 50, or 5 with --include-source)
  --source-chars     Truncate each symbol's source to N characters`,

  tree: `codesift tree <repo> [options]

Get the file tree of a repository with symbol counts per file.

Arguments:
  <repo>    Repository identifier

Options:
  --path            Filter to a subtree by path prefix
  --name-pattern    Glob pattern to filter file names
  --depth           Maximum directory depth
  --compact         Return flat list instead of nested tree
  --min-symbols     Only include files with at least N symbols`,

  outline: `codesift outline <repo> <file>

Get the symbol outline of a single file.

Arguments:
  <repo>    Repository identifier
  <file>    Relative file path within the repository`,

  "repo-outline": `codesift repo-outline <repo>

Get a high-level outline of the entire repository grouped by directory.

Arguments:
  <repo>    Repository identifier`,

  symbol: `codesift symbol <repo> <id>

Retrieve a single symbol by its unique ID with full source code.

Arguments:
  <repo>    Repository identifier
  <id>      Unique symbol identifier`,

  "symbols-batch": `codesift symbols-batch <repo> <ids...>

Retrieve multiple symbols by ID in a single batch call.

Arguments:
  <repo>      Repository identifier
  <ids...>    Space-separated symbol identifiers`,

  find: `codesift find <repo> <query> [options]

Find a symbol by name and show its source.

Arguments:
  <repo>     Repository identifier
  <query>    Symbol name or query to search for

Options:
  --include-refs    Include locations that reference this symbol`,

  refs: `codesift refs <repo> <name> [options]

Find all references to a symbol across the codebase.

Arguments:
  <repo>    Repository identifier
  <name>    Name of the symbol to find references for

Options:
  --file-pattern    Glob pattern to filter files
  --json            Output full JSON instead of compact table`,

  trace: `codesift trace <repo> <name> [options]

Trace the call chain of a symbol.

Arguments:
  <repo>    Repository identifier
  <name>    Name of the symbol to trace

Options:
  --direction       Trace direction: callers or callees (default: callers)
  --depth           Maximum depth to traverse (default: 1)
  --include-source  Include full source code of each symbol
  --include-tests   Include test files in trace results
  --json            Output full JSON instead of compact tree`,

  impact: `codesift impact <repo> --since <ref> [options]

Analyze the blast radius of recent git changes.

Arguments:
  <repo>    Repository identifier

Options:
  --since    Git ref to compare from (required, e.g. HEAD~3, commit SHA)
  --depth    Depth of dependency traversal
  --until    Git ref to compare to (default: HEAD)`,

  context: `codesift context <repo> <query> [options]

Assemble a focused code context for a query within a token budget.

Arguments:
  <repo>     Repository identifier
  <query>    Natural language query describing what context is needed

Options:
  --token-budget    Maximum tokens for the assembled context`,

  "knowledge-map": `codesift knowledge-map <repo> [options]

Get the module dependency map showing how files relate.

Arguments:
  <repo>    Repository identifier

Options:
  --focus    Focus on a specific module or directory
  --depth    Maximum depth of the dependency graph`,

  diff: `codesift diff <repo> --since <ref> [options]

Get a structural outline of what changed between two git refs.

Arguments:
  <repo>    Repository identifier

Options:
  --since    Git ref to compare from (required)
  --until    Git ref to compare to (default: HEAD)`,

  changed: `codesift changed <repo> --since <ref> [options]

List symbols in each changed file between two git refs.

Arguments:
  <repo>    Repository identifier

Options:
  --since    Git ref to compare from (required)
  --until    Git ref to compare to (default: HEAD)`,

  retrieve: `codesift retrieve <repo> --queries <json> [options]

Execute multiple search/retrieval queries in a single batched call.

Arguments:
  <repo>    Repository identifier

Options:
  --queries              JSON array of sub-queries (required)
  --token-budget         Maximum total tokens across all results
  --exclude-tests        Exclude test files from semantic/hybrid results (default: true)
  --exclude-tests=false  Include test files in semantic/hybrid results

Sub-query types: symbols, text, file_tree, outline, references,
  call_chain, impact, context, knowledge_map, semantic, hybrid

Semantic/hybrid sub-queries support an "exclude_tests" field (default: true).

Example:
  codesift retrieve local/my-project --queries '[{"type":"symbols","query":"createUser"},{"type":"text","query":"TODO"}]'
  codesift retrieve local/my-project --queries '[{"type":"semantic","query":"caching"}]' --exclude-tests=false`,

  stats: `codesift stats

Show usage statistics for all CodeSift tool calls.`,

  "generate-claude-md": `codesift generate-claude-md <repo> [options]

Generate a CLAUDE.md project summary from the repository index.

Arguments:
  <repo>    Repository identifier

Options:
  --output    Custom output file path`,

  complexity: `codesift complexity <repo> [options]

Analyze cyclomatic complexity of functions in a repository.

Arguments:
  <repo>    Repository identifier

Options:
  --file-pattern      Filter to files matching this path substring
  --top-n             Return top N most complex functions (default: 30)
  --min-complexity    Minimum cyclomatic complexity to include (default: 1)
  --include-tests     Include test files (default: false)`,

  "dead-code": `codesift dead-code <repo> [options]

Find potentially dead code: exported symbols with zero references outside their defining file.

Arguments:
  <repo>    Repository identifier

Options:
  --file-pattern     Filter to files matching this path substring
  --include-tests    Include test files in scan (default: false)`,

  hotspots: `codesift hotspots <repo> [options]

Analyze git churn hotspots: files with high change frequency x complexity.

Arguments:
  <repo>    Repository identifier

Options:
  --since-days       Look back N days (default: 90)
  --top-n            Return top N hotspots (default: 30)
  --file-pattern     Filter to files matching this path substring`,

  communities: `codesift communities <repo> [options]

Detect code clusters/modules using Louvain community detection on the import graph.

Arguments:
  <repo>    Repository identifier

Options:
  --focus            Path substring to filter files (e.g. 'src/lib')
  --resolution       Louvain resolution: higher = more smaller communities (default: 1.0)
  --output-format    Output format: 'json' (default) or 'mermaid'`,

  patterns: `codesift patterns <repo> --pattern <name> [options]

Search for structural code patterns (anti-patterns, CQ violations).

Arguments:
  <repo>    Repository identifier

Options:
  --pattern          Pattern name or custom regex (required)
  --file-pattern     Filter to files matching this path substring
  --include-tests    Include test files (default: false)
  --max-results      Max results (default: 50)

Built-in patterns: useEffect-no-cleanup, empty-catch, any-type, console-log,
  await-in-loop, no-error-type, toctou, unbounded-findmany`,

  "find-clones": `codesift find-clones <repo> [options]

Find code clones: pairs of functions with similar normalized source (copy-paste detection).

Arguments:
  <repo>    Repository identifier

Options:
  --file-pattern     Filter to files matching this path substring
  --threshold        Minimum similarity threshold 0-1 (default: 0.7)
  --min-lines        Minimum normalized lines to consider (default: 10)
  --include-tests    Include test files (default: false)`,

  "precheck-read": `codesift precheck-read

PreToolUse hook handler for the Read tool.
Exits 2 (deny) when the agent attempts to read a large code file, redirecting
to CodeSift tools instead. Exits 0 (allow) otherwise.

This command is designed to be installed as a Claude Code PreToolUse hook via:
  codesift setup claude --hooks

Env vars:
  HOOK_TOOL_INPUT                 JSON with tool_input.file_path (set by Claude Code)
  CODESIFT_READ_HOOK_MIN_LINES    Override line threshold (default: 200)`,

  "precheck-bash": `codesift precheck-bash

PreToolUse hook handler for the Bash tool.
Exits 2 (deny) when the agent attempts to run file-finding (find ... -name) or
content-searching (grep -r, rg) commands, redirecting to CodeSift tools instead.
Exits 0 (allow) for all other Bash commands.

This ensures sub-agents (Explore, Plan, etc.) use the CodeSift index rather than
raw shell commands. Installed as a Claude Code PreToolUse hook via:
  codesift setup claude --hooks

Env vars:
  HOOK_TOOL_INPUT    JSON with tool_input.command (set by Claude Code)`,

  "postindex-file": `codesift postindex-file

PostToolUse hook handler for Write/Edit tools.
Re-indexes the file that was just written or edited, keeping the CodeSift index
in sync with the agent's edits. Always exits 0 (fire-and-forget).

This command is designed to be installed as a Claude Code PostToolUse hook via:
  codesift setup claude --hooks

Env vars:
  HOOK_TOOL_INPUT    JSON with tool_input.file_path (set by Claude Code)`,

  "wiki-generate": "Generate wiki pages from code topology.\nUsage: codesift wiki-generate [repo] [--focus <path>] [--output <dir>] [--no-lens] [--trim]",

  "wiki-lint": "Check wiki for broken links and stale references.\nUsage: codesift wiki-lint <wiki-dir> [--current-hash <hash>]",

  setup: `codesift setup <platform>

Configure codesift-mcp as an MCP server in an AI coding tool.
By default, installs the MCP server config, rules file, and hooks (where supported).

Platforms:
  codex         Add to ~/.codex/config.toml + AGENTS.md rules (OpenAI Codex CLI & IDE)
  claude        Add to ~/.claude/settings.json + rules + hooks (Claude Code)
  cursor        Add to ~/.cursor/mcp.json + .cursor/rules/codesift.mdc (Cursor IDE)
  gemini        Add to ~/.gemini/settings.json + GEMINI.md rules (Gemini CLI)
  antigravity   Add to ~/.gemini/antigravity/mcp_config.json (Google Antigravity)
  all       Configure all platforms at once

Options:
  --json        Output result as JSON instead of human-readable text
  --hooks       Install hooks where supported (default: on)
  --no-hooks    Skip hook installation
  --rules       Install platform rules file (default: on)
  --no-rules    Skip rules file installation
  --force       Overwrite rules file even if it has been modified by the user

What it does:
  - Creates the config file if it doesn't exist
  - Adds the codesift MCP server entry if not already present
  - Installs the CodeSift rules file for the platform (use --no-rules to skip)
  - Installs hooks for supported platforms (currently Claude Code, Codex, Gemini)
  - Skips if already configured (safe to run multiple times)

Examples:
  codesift setup codex
  codesift setup claude
  codesift setup claude --no-hooks
  codesift setup claude --no-rules
  codesift setup claude --force
  codesift setup cursor
  codesift setup gemini
  codesift setup antigravity
  codesift setup all`,
};
