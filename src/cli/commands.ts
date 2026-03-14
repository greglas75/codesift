// ---------------------------------------------------------------------------
// CLI command handlers
// ---------------------------------------------------------------------------

import type { Flags } from "./args.js";
import { getFlag, getBoolFlag, getNumFlag, requireArg, output, die } from "./args.js";

export type CommandHandler = (args: string[], flags: Flags) => Promise<void>;

// ---------------------------------------------------------------------------
// Index commands
// ---------------------------------------------------------------------------

async function handleIndex(args: string[], flags: Flags): Promise<void> {
  const path = requireArg(args, 0, "path");
  const { indexFolder } = await import("../tools/index-tools.js");

  const includePathsRaw = getFlag(flags, "include-paths");
  const includePaths = includePathsRaw ? includePathsRaw.split(",").map(p => p.trim()) : undefined;

  const result = await indexFolder(path, {
    incremental: getBoolFlag(flags, "incremental"),
    include_paths: includePaths,
    watch: getBoolFlag(flags, "no-watch") === true ? false : undefined,
  });
  output(result, flags);
}

async function handleIndexRepo(args: string[], flags: Flags): Promise<void> {
  const url = requireArg(args, 0, "url");
  const { indexRepo } = await import("../tools/index-tools.js");

  const includePathsRaw = getFlag(flags, "include-paths");
  const includePaths = includePathsRaw ? includePathsRaw.split(",").map(p => p.trim()) : undefined;

  const result = await indexRepo(url, {
    branch: getFlag(flags, "branch"),
    include_paths: includePaths,
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
  });
  output(result, flags);
}

async function handleSymbols(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const query = requireArg(args, 1, "query");
  const { searchSymbols } = await import("../tools/search-tools.js");
  type SymbolKind = import("../types.js").SymbolKind;

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

async function handleTrace(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const name = requireArg(args, 1, "name");
  const { traceCallChain } = await import("../tools/graph-tools.js");
  type Direction = import("../types.js").Direction;
  type CallNode = import("../types.js").CallNode;

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

async function handleImpact(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
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
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
  const { diffOutline } = await import("../tools/diff-tools.js");

  const result = await diffOutline(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

async function handleChanged(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const since = getFlag(flags, "since");
  if (!since) {
    die("Missing required flag: --since <ref>");
  }
  const { changedSymbols } = await import("../tools/diff-tools.js");

  const result = await changedSymbols(repo, since, getFlag(flags, "until"));
  output(result, flags);
}

// ---------------------------------------------------------------------------
// Retrieval & utility commands
// ---------------------------------------------------------------------------

async function handleRetrieve(args: string[], flags: Flags): Promise<void> {
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

  // --exclude-tests (default: true) — pass to semantic/hybrid sub-queries
  // Use --no-exclude-tests or --exclude-tests=false to include test files
  const excludeTestsFlag = getBoolFlag(flags, "exclude-tests");
  const excludeTests = excludeTestsFlag !== false; // default true
  if (excludeTests) {
    // Inject exclude_tests into semantic/hybrid sub-queries that don't already specify it
    for (const q of queries) {
      if ((q.type === "semantic" || q.type === "hybrid") && q["exclude_tests"] === undefined) {
        q["exclude_tests"] = true;
      }
    }
  } else {
    // Explicitly set false on semantic/hybrid sub-queries
    for (const q of queries) {
      if ((q.type === "semantic" || q.type === "hybrid") && q["exclude_tests"] === undefined) {
        q["exclude_tests"] = false;
      }
    }
  }

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
