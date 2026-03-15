// ---------------------------------------------------------------------------
// CLI command handlers
// ---------------------------------------------------------------------------

import type { Flags } from "./args.js";
import type { CallNode } from "../types.js";
import { getFlag, getBoolFlag, getNumFlag, requireArg, requireFlag, parseCommaSeparated, output, die } from "./args.js";

export type CommandHandler = (args: string[], flags: Flags) => Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "function", "method", "class", "interface", "type", "variable", "constant",
  "field", "enum", "namespace", "module", "section", "metadata",
  "test_suite", "test_case", "test_hook", "default_export", "unknown",
]);

const EXCLUDE_TESTS_QUERY_TYPES: ReadonlySet<string> = new Set(["semantic", "hybrid"]);

// ---------------------------------------------------------------------------
// Index commands
// ---------------------------------------------------------------------------

async function handleIndex(args: string[], flags: Flags): Promise<void> {
  const path = requireArg(args, 0, "path");
  const { indexFolder } = await import("../tools/index-tools.js");

  const result = await indexFolder(path, {
    incremental: getBoolFlag(flags, "incremental"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
    watch: getBoolFlag(flags, "no-watch") === true ? false : undefined,
  });
  output(result, flags);
}

async function handleIndexRepo(args: string[], flags: Flags): Promise<void> {
  const url = requireArg(args, 0, "url");
  const { indexRepo } = await import("../tools/index-tools.js");

  const result = await indexRepo(url, {
    branch: getFlag(flags, "branch"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
  });
  output(result, flags);
}

async function handleRepos(_args: string[], flags: Flags): Promise<void> {
  const { listAllRepos } = await import("../tools/index-tools.js");
  const result = await listAllRepos();
  output(result, flags);
}

async function handleInvalidate(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { invalidateCache } = await import("../tools/index-tools.js");
  const result = await invalidateCache(repo);
  output({ invalidated: result, repo }, flags);
}

// ---------------------------------------------------------------------------
// Search commands
// ---------------------------------------------------------------------------

async function handleSearch(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchText } = await import("../tools/search-tools.js");

  const result = await searchText(repo, query, {
    file_pattern: getFlag(flags, "file-pattern"),
    regex: getBoolFlag(flags, "regex"),
    context_lines: getNumFlag(flags, "context-lines"),
    max_results: getNumFlag(flags, "max-results"),
    group_by_file: getBoolFlag(flags, "group-by-file"),
  });
  output(result, flags);
}

async function handleSymbols(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchSymbols } = await import("../tools/search-tools.js");
  type SymbolKind = import("../types.js").SymbolKind;

  const kindRaw = getFlag(flags, "kind");
  if (kindRaw !== undefined && !VALID_SYMBOL_KINDS.has(kindRaw)) {
    die(`Invalid --kind: ${kindRaw}. Valid: ${Array.from(VALID_SYMBOL_KINDS).join(", ")}`);
  }

  const includeSource = getBoolFlag(flags, "include-source");
  const explicitTopK = getNumFlag(flags, "top-k");
  // When --include-source is set and no explicit --top-k, default to 5
  // instead of 50 to avoid returning 50 full function bodies
  const topK = explicitTopK ?? (includeSource ? 5 : undefined);

  const result = await searchSymbols(repo, query, {
    kind: kindRaw as SymbolKind | undefined,
    file_pattern: getFlag(flags, "file-pattern"),
    include_source: includeSource,
    top_k: topK,
    source_chars: getNumFlag(flags, "source-chars"),
  });
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Outline commands
// ---------------------------------------------------------------------------

async function handleTree(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getFileTree } = await import("../tools/outline-tools.js");

  const result = await getFileTree(repo, {
    path_prefix: getFlag(flags, "path") ?? args[1],
    name_pattern: getFlag(flags, "name-pattern"),
    depth: getNumFlag(flags, "depth"),
    compact: getBoolFlag(flags, "compact"),
    min_symbols: getNumFlag(flags, "min-symbols"),
  });
  output(result, flags);
}

async function handleOutline(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const file = requireArg(args, 1, "file");
  const { getFileOutline } = await import("../tools/outline-tools.js");

  const result = await getFileOutline(repo, file);
  output(result, flags);
}

async function handleRepoOutline(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getRepoOutline } = await import("../tools/outline-tools.js");

  const result = await getRepoOutline(repo);
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Symbol commands
// ---------------------------------------------------------------------------

async function handleSymbol(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const id = requireArg(args, 1, "id");
  const { getSymbol } = await import("../tools/symbol-tools.js");

  const result = await getSymbol(repo, id);
  if (result === null) {
    die(`Symbol not found: ${id}`);
  }
  output(result, flags);
}

async function handleSymbolsBatch(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const ids = args.slice(1);
  if (ids.length === 0) {
    die("Missing required argument: <ids...>");
  }
  const { getSymbols } = await import("../tools/symbol-tools.js");

  const result = await getSymbols(repo, ids);
  output(result, flags);
}

async function handleFind(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { findAndShow } = await import("../tools/symbol-tools.js");

  const result = await findAndShow(repo, query, getBoolFlag(flags, "include-refs"));
  if (result === null) {
    die(`No symbol found matching: ${query}`);
  }
  output(result, flags);
}

async function handleRefs(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { findReferences } = await import("../tools/symbol-tools.js");

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

// ---------------------------------------------------------------------------
// Graph commands
// ---------------------------------------------------------------------------

function printTraceCompact(root: CallNode): void {
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
  printNode(root, 0);

  function countNodes(node: CallNode): number {
    return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
  }
  process.stderr.write(`\n${countNodes(root)} symbols in trace\n`);
}

async function handleTrace(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { traceCallChain } = await import("../tools/graph-tools.js");
  type Direction = import("../types.js").Direction;

  const direction = (getFlag(flags, "direction") ?? "callers") as Direction;
  if (direction !== "callers" && direction !== "callees") {
    die(`Invalid --direction: ${direction}. Must be "callers" or "callees".`);
  }

  const result = await traceCallChain(repo, name, direction, {
    depth: getNumFlag(flags, "depth"),
    include_source: getBoolFlag(flags, "include-source") ?? false,
    include_tests: getBoolFlag(flags, "include-tests") ?? false,
  });

  if (getBoolFlag(flags, "json")) {
    output(result, flags);
  } else {
    printTraceCompact(result);
  }
}

async function handleImpact(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { impactAnalysis } = await import("../tools/graph-tools.js");

  const result = await impactAnalysis(repo, since, {
    depth: getNumFlag(flags, "depth"),
    until: getFlag(flags, "until"),
    include_source: getBoolFlag(flags, "include-source"),
  });
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Context commands
// ---------------------------------------------------------------------------

async function handleContext(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { assembleContext } = await import("../tools/context-tools.js");

  const result = await assembleContext(repo, query, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleKnowledgeMap(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { getKnowledgeMap } = await import("../tools/context-tools.js");

  const result = await getKnowledgeMap(repo, getFlag(flags, "focus"), getNumFlag(flags, "depth"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Diff commands
// ---------------------------------------------------------------------------

async function handleDiff(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { diffOutline } = await import("../tools/diff-tools.js");

  const result = await diffOutline(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

async function handleChanged(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = requireFlag(flags, "since");
  const { changedSymbols } = await import("../tools/diff-tools.js");

  const result = await changedSymbols(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Retrieval & utility commands
// ---------------------------------------------------------------------------

function parseRetrievalQueries(flags: Flags): Array<{ type: string; [key: string]: unknown }> {
  const queriesRaw = getFlag(flags, "queries");
  if (!queriesRaw) {
    die("Missing required flag: --queries <json>");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(queriesRaw);
  } catch {
    die("Invalid JSON for --queries flag");
  }

  if (!Array.isArray(parsed)) {
    die("--queries must be a JSON array");
  }

  for (const item of parsed) {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).type !== "string") {
      die("Each --queries entry must be an object with a \"type\" string field");
    }
  }

  const queries = parsed as Array<{ type: string; [key: string]: unknown }>;

  // --exclude-tests (default: true) — inject into semantic/hybrid sub-queries
  const excludeTests = getBoolFlag(flags, "exclude-tests") !== false;
  for (const q of queries) {
    if (EXCLUDE_TESTS_QUERY_TYPES.has(q.type) && q["exclude_tests"] === undefined) {
      q["exclude_tests"] = excludeTests;
    }
  }

  return queries;
}

async function handleRetrieve(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const queries = parseRetrievalQueries(flags);
  const { codebaseRetrieval } = await import("../retrieval/codebase-retrieval.js");

  const result = await codebaseRetrieval(repo, queries, getNumFlag(flags, "token-budget"));
  output(result, flags);
}

async function handleStats(_args: string[], flags: Flags): Promise<void> {
  const { getUsageStats, formatUsageReport } = await import("../storage/usage-stats.js");
  const stats = await getUsageStats();

  // If --json flag is set (or default), output raw stats; otherwise formatted report
  if (getBoolFlag(flags, "json") === false) {
    const report = formatUsageReport(stats);
    process.stdout.write(report + "\n");
  } else {
    output(stats, flags);
  }
}

async function handleGenerateClaudeMd(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { generateClaudeMd } = await import("../tools/generate-tools.js");

  const result = await generateClaudeMd(repo, getFlag(flags, "output"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Command dispatch map
// ---------------------------------------------------------------------------

export const COMMAND_MAP: Record<string, CommandHandler> = {
  "index": handleIndex,
  "index-repo": handleIndexRepo,
  "repos": handleRepos,
  "invalidate": handleInvalidate,
  "search": handleSearch,
  "symbols": handleSymbols,
  "tree": handleTree,
  "outline": handleOutline,
  "repo-outline": handleRepoOutline,
  "symbol": handleSymbol,
  "symbols-batch": handleSymbolsBatch,
  "find": handleFind,
  "refs": handleRefs,
  "trace": handleTrace,
  "impact": handleImpact,
  "context": handleContext,
  "knowledge-map": handleKnowledgeMap,
  "diff": handleDiff,
  "changed": handleChanged,
  "retrieve": handleRetrieve,
  "stats": handleStats,
  "generate-claude-md": handleGenerateClaudeMd,
};
