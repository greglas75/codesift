#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // Boolean flags: no next value, or next value is also a flag
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function getFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const val = flags[name];
  if (val === undefined || typeof val === "boolean") return undefined;
  return val;
}

function getBoolFlag(flags: Record<string, string | boolean>, name: string): boolean | undefined {
  const val = flags[name];
  if (val === undefined) return undefined;
  if (val === true || val === "true") return true;
  if (val === "false") return false;
  return true;
}

function getNumFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = getFlag(flags, name);
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (isNaN(num)) {
    die(`Invalid number for --${name}: ${raw}`);
  }
  return num;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function output(data: unknown, flags: Record<string, string | boolean>): void {
  const compact = getBoolFlag(flags, "compact");
  const indent = compact ? undefined : 2;
  process.stdout.write(JSON.stringify(data, null, indent) + "\n");
}

function die(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function requireArg(args: string[], index: number, name: string): string {
  const val = args[index];
  if (val === undefined) {
    die(`Missing required argument: <${name}>`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const MAIN_HELP = `codesift — CLI for CodeSift code intelligence

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

const COMMAND_HELP: Record<string, string> = {
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
  --queries         JSON array of sub-queries (required)
  --token-budget    Maximum total tokens across all results

Sub-query types: symbols, text, file_tree, outline, references,
  call_chain, impact, context, knowledge_map, semantic, hybrid

Example:
  codesift retrieve local/my-project --queries '[{"type":"symbols","query":"createUser"},{"type":"text","query":"TODO"}]'`,

  stats: `codesift stats

Show usage statistics for all CodeSift tool calls.`,

  "generate-claude-md": `codesift generate-claude-md <repo> [options]

Generate a CLAUDE.md project summary from the repository index.

Arguments:
  <repo>    Repository identifier

Options:
  --output    Custom output file path`,
};

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleIndex(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const path = requireArg(args, 0, "path");
  const { indexFolder } = await import("./tools/index-tools.js");

  const includePathsRaw = getFlag(flags, "include-paths");
  const includePaths = includePathsRaw ? includePathsRaw.split(",").map(p => p.trim()) : undefined;

  const result = await indexFolder(path, {
    incremental: getBoolFlag(flags, "incremental"),
    include_paths: includePaths,
    watch: getBoolFlag(flags, "no-watch") === true ? false : undefined,
  });
  output(result, flags);
}

async function handleIndexRepo(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = requireArg(args, 0, "url");
  const { indexRepo } = await import("./tools/index-tools.js");

  const includePathsRaw = getFlag(flags, "include-paths");
  const includePaths = includePathsRaw ? includePathsRaw.split(",").map(p => p.trim()) : undefined;

  const result = await indexRepo(url, {
    branch: getFlag(flags, "branch"),
    include_paths: includePaths,
  });
  output(result, flags);
}

async function handleRepos(flags: Record<string, string | boolean>): Promise<void> {
  const { listAllRepos } = await import("./tools/index-tools.js");
  const result = await listAllRepos();
  output(result, flags);
}

async function handleInvalidate(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { invalidateCache } = await import("./tools/index-tools.js");
  const result = await invalidateCache(repo);
  output({ invalidated: result, repo }, flags);
}

async function handleSearch(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchText } = await import("./tools/search-tools.js");

  const result = await searchText(repo, query, {
    file_pattern: getFlag(flags, "file-pattern"),
    regex: getBoolFlag(flags, "regex"),
    context_lines: getNumFlag(flags, "context-lines"),
    max_results: getNumFlag(flags, "max-results"),
  });
  output(result, flags);
}

async function handleSymbols(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchSymbols } = await import("./tools/search-tools.js");
  type SymbolKind = import("./types.js").SymbolKind;

  const includeSource = getBoolFlag(flags, "include-source");
  const explicitTopK = getNumFlag(flags, "top-k");
  // When --include-source is set and no explicit --top-k, default to 5
  // instead of 50 to avoid returning 50 full function bodies
  const topK = explicitTopK ?? (includeSource ? 5 : undefined);

  const result = await searchSymbols(repo, query, {
    kind: getFlag(flags, "kind") as SymbolKind | undefined,
    file_pattern: getFlag(flags, "file-pattern"),
    include_source: includeSource,
    top_k: topK,
    source_chars: getNumFlag(flags, "source-chars"),
  });
  output(result, flags);
}

async function handleTree(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getFileTree } = await import("./tools/outline-tools.js");

  const result = await getFileTree(repo, {
    path_prefix: getFlag(flags, "path") ?? args[1],
    name_pattern: getFlag(flags, "name-pattern"),
    depth: getNumFlag(flags, "depth"),
    compact: getBoolFlag(flags, "compact"),
    min_symbols: getNumFlag(flags, "min-symbols"),
  });
  output(result, flags);
}

async function handleOutline(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const file = requireArg(args, 1, "file");
  const { getFileOutline } = await import("./tools/outline-tools.js");

  const result = await getFileOutline(repo, file);
  output(result, flags);
}

async function handleRepoOutline(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getRepoOutline } = await import("./tools/outline-tools.js");

  const result = await getRepoOutline(repo);
  output(result, flags);
}

async function handleSymbol(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const id = requireArg(args, 1, "id");
  const { getSymbol } = await import("./tools/symbol-tools.js");

  const result = await getSymbol(repo, id);
  if (result === null) {
    die(`Symbol not found: ${id}`);
  }
  output(result, flags);
}

async function handleSymbolsBatch(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const ids = args.slice(1);
  if (ids.length === 0) {
    die("Missing required argument: <ids...>");
  }
  const { getSymbols } = await import("./tools/symbol-tools.js");

  const result = await getSymbols(repo, ids);
  output(result, flags);
}

async function handleFind(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { findAndShow } = await import("./tools/symbol-tools.js");

  const result = await findAndShow(repo, query, getBoolFlag(flags, "include-refs"));
  if (result === null) {
    die(`No symbol found matching: ${query}`);
  }
  output(result, flags);
}

async function handleRefs(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { findReferences } = await import("./tools/symbol-tools.js");

  const result = await findReferences(repo, name, getFlag(flags, "file-pattern"));

  if (getBoolFlag(flags, "json")) {
    output(result, flags);
  } else {
    // Compact tabular output: file:line:col | context
    for (const ref of result) {
      const loc = `${ref.file}:${ref.line}${ref.col ? `:${ref.col}` : ""}`;
      process.stdout.write(`${loc} | ${ref.context}\n`);
    }
    process.stderr.write(`\n${result.length} references found\n`);
  }
}

async function handleTrace(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { traceCallChain } = await import("./tools/graph-tools.js");
  type Direction = import("./types.js").Direction;
  type CallNode = import("./types.js").CallNode;

  const direction = (getFlag(flags, "direction") ?? "callers") as Direction;
  if (direction !== "callers" && direction !== "callees") {
    die(`Invalid --direction: ${direction}. Must be "callers" or "callees".`);
  }

  const includeSource = getBoolFlag(flags, "include-source") ?? false;
  const includeTests = getBoolFlag(flags, "include-tests") ?? false;
  const result = await traceCallChain(repo, name, direction, {
    depth: getNumFlag(flags, "depth"),
    include_source: includeSource,
    include_tests: includeTests,
  });

  if (getBoolFlag(flags, "json")) {
    output(result, flags);
  } else {
    // Compact tree output
    function printNode(node: CallNode, indent: number): void {
      const prefix = indent === 0 ? "" : "  ".repeat(indent) + "|- ";
      const sym = node.symbol;
      const sig = sym.signature ? ` ${sym.signature}` : "";
      const loc = `${sym.file}:${sym.start_line}`;
      process.stdout.write(`${prefix}${sym.kind} | ${sym.name}${sig} | ${loc}\n`);
      for (const child of node.children) {
        printNode(child, indent + 1);
      }
    }
    printNode(result, 0);

    // Count total nodes
    function countNodes(node: CallNode): number {
      return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
    }
    process.stderr.write(`\n${countNodes(result)} symbols in trace\n`);
  }
}

async function handleImpact(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
  const { impactAnalysis } = await import("./tools/graph-tools.js");

  const result = await impactAnalysis(repo, since, {
    depth: getNumFlag(flags, "depth"),
    until: getFlag(flags, "until"),
    include_source: getBoolFlag(flags, "include-source"),
  });
  output(result, flags);
}

async function handleContext(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { assembleContext } = await import("./tools/context-tools.js");

  const result = await assembleContext(repo, query, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleKnowledgeMap(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getKnowledgeMap } = await import("./tools/context-tools.js");

  const result = await getKnowledgeMap(repo, getFlag(flags, "focus"), getNumFlag(flags, "depth"));
  output(result, flags);
}

async function handleDiff(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
  const { diffOutline } = await import("./tools/diff-tools.js");

  const result = await diffOutline(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

async function handleChanged(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
  const { changedSymbols } = await import("./tools/diff-tools.js");

  const result = await changedSymbols(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

async function handleRetrieve(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const queriesRaw = getFlag(flags, "queries");
  if (!queriesRaw) {
    die("Missing required flag: --queries <json>");
  }

  let queries: Array<{ type: string; [key: string]: unknown }>;
  try {
    const parsed: unknown = JSON.parse(queriesRaw);
    if (!Array.isArray(parsed)) {
      die("--queries must be a JSON array");
    }
    queries = parsed as Array<{ type: string; [key: string]: unknown }>;
  } catch {
    die("Invalid JSON for --queries flag");
  }

  const { codebaseRetrieval } = await import("./retrieval/codebase-retrieval.js");

  const result = await codebaseRetrieval(repo, queries, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleStats(flags: Record<string, string | boolean>): Promise<void> {
  const { getUsageStats, formatUsageReport } = await import("./storage/usage-stats.js");
  const stats = await getUsageStats();

  // If --json flag is set (or default), output raw stats; otherwise formatted report
  if (getBoolFlag(flags, "json") === false) {
    const report = formatUsageReport(stats);
    process.stdout.write(report + "\n");
  } else {
    output(stats, flags);
  }
}

async function handleGenerateClaudeMd(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { generateClaudeMd } = await import("./tools/generate-tools.js");

  const result = await generateClaudeMd(repo, getFlag(flags, "output"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

async function getVersion(): Promise<string> {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // Try dist/../package.json first, then src/../package.json
    for (const base of [join(thisDir, ".."), join(thisDir, "..", "..")]) {
      try {
        const raw = await readFile(join(base, "package.json"), "utf-8");
        const pkg: unknown = JSON.parse(raw);
        if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
          return String((pkg as Record<string, unknown>)["version"]);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);

  const command = positional[0];
  const commandArgs = positional.slice(1);

  // Handle top-level flags
  if (getBoolFlag(flags, "version") || command === "--version") {
    const version = await getVersion();
    process.stdout.write(`codesift ${version}\n`);
    return;
  }

  if (getBoolFlag(flags, "help") && !command) {
    process.stdout.write(MAIN_HELP);
    return;
  }

  if (!command) {
    process.stdout.write(MAIN_HELP);
    return;
  }

  // Per-command help
  if (getBoolFlag(flags, "help")) {
    const help = COMMAND_HELP[command];
    if (help) {
      process.stdout.write(help + "\n");
    } else {
      die(`Unknown command: ${command}. Run 'codesift --help' for available commands.`);
    }
    return;
  }

  // Initialize config before running any command
  loadConfig();

  switch (command) {
    case "index":
      await handleIndex(commandArgs, flags);
      break;
    case "index-repo":
      await handleIndexRepo(commandArgs, flags);
      break;
    case "repos":
      await handleRepos(flags);
      break;
    case "invalidate":
      await handleInvalidate(commandArgs, flags);
      break;
    case "search":
      await handleSearch(commandArgs, flags);
      break;
    case "symbols":
      await handleSymbols(commandArgs, flags);
      break;
    case "tree":
      await handleTree(commandArgs, flags);
      break;
    case "outline":
      await handleOutline(commandArgs, flags);
      break;
    case "repo-outline":
      await handleRepoOutline(commandArgs, flags);
      break;
    case "symbol":
      await handleSymbol(commandArgs, flags);
      break;
    case "symbols-batch":
      await handleSymbolsBatch(commandArgs, flags);
      break;
    case "find":
      await handleFind(commandArgs, flags);
      break;
    case "refs":
      await handleRefs(commandArgs, flags);
      break;
    case "trace":
      await handleTrace(commandArgs, flags);
      break;
    case "impact":
      await handleImpact(commandArgs, flags);
      break;
    case "context":
      await handleContext(commandArgs, flags);
      break;
    case "knowledge-map":
      await handleKnowledgeMap(commandArgs, flags);
      break;
    case "diff":
      await handleDiff(commandArgs, flags);
      break;
    case "changed":
      await handleChanged(commandArgs, flags);
      break;
    case "retrieve":
      await handleRetrieve(commandArgs, flags);
      break;
    case "stats":
      await handleStats(flags);
      break;
    case "generate-claude-md":
      await handleGenerateClaudeMd(commandArgs, flags);
      break;
    default:
      die(`Unknown command: ${command}. Run 'codesift --help' for available commands.`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
