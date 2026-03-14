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

Flags:
  --help            Show help for a command
  --version         Show version
  --compact         Compact JSON output (no indentation)
  --json            Full JSON output (for refs, trace commands)
  --include-source  Include source code in output (trace, impact)

Examples:
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
};
