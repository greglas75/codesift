import { z, zBool, lazySchema, OutputSchemas, detectAutoLoadToolsCached, enableToolByName, type ToolDefinitionEntry } from "../shared.js";
import { indexFolder, indexFile, indexRepo, listAllRepos, invalidateCache } from "../deps.js";
import { zJsonArray } from "./schema.js";

export const CORE_INDEX_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Indexing ---
  { order: 1154, definition: {
    name: "index_folder",
    category: "indexing",
    searchHint: "index local folder directory project parse symbols",
    description: "Index a local folder, extracting symbols and building the search index",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the folder to index"),
      incremental: zBool().describe("Only re-index changed files"),
      include_paths: z.union([
        z.array(z.string().trim().min(1)),
        zJsonArray(z.string().trim().min(1)),
      ]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
      max_files: z.number().int().positive().optional().describe("Cap on files indexed. Default 50000 (or CODESIFT_MAX_FILES env). Walker stops at this count and returns partial results — protects against OOM on huge repos. Use include_paths to scope instead of raising this for large vendored trees."),
      watch: zBool().describe("Whether to set up a chokidar file watcher for incremental updates after indexing. Default true. Pass false for bulk/CI indexing scenarios — file watchers consume system file descriptors (1+ per repo on macOS FSEvents); indexing many repos with watchers active can exhaust the system file table (ENFILE)."),
    })),
    handler: async (args) => {
      const result = await indexFolder(args.path as string, {
        incremental: args.incremental as boolean | undefined,
        include_paths: args.include_paths as string[] | undefined,
        max_files: args.max_files as number | undefined,
        watch: args.watch as boolean | undefined,
      });
      // Auto-enable framework tools based on indexed path (not CWD)
      try {
        const toEnable = await detectAutoLoadToolsCached(args.path as string);
        for (const name of toEnable) enableToolByName(name);
      } catch { /* best-effort — non-fatal */ }
      return result;
    },
  } },
  { order: 1181, definition: {
    name: "index_repo",
    category: "indexing",
    searchHint: "clone remote git repository index",
    description: "Clone and index a remote git repository",
    schema: lazySchema(() => ({
      url: z.string().describe("Git clone URL"),
      branch: z.string().optional().describe("Branch to checkout"),
      include_paths: z.union([
        z.array(z.string().trim().min(1)),
        zJsonArray(z.string().trim().min(1)),
      ]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    })),
    handler: (args) => indexRepo(args.url as string, {
      branch: args.branch as string | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  } },
  { order: 1196, definition: {
    name: "list_repos",
    category: "indexing",
    searchHint: "list indexed repositories repos available",
    outputSchema: OutputSchemas.repoList,
    description: "List indexed CODE repos. Only needed for multi-repo discovery — single-repo tools auto-resolve from CWD. Conversation indexes are excluded unless include_conversations=true. Set compact=false for full metadata.",
    schema: lazySchema(() => ({
      compact: zBool().describe("true=names only (default), false=full metadata"),
      name_contains: z.string().optional().describe("Filter repos by name substring (case-insensitive). E.g. 'tgm' matches 'local/tgm-panel'"),
      include_conversations: zBool().describe("Include conversation indexes (conversations/*), which search_conversations uses. Default false — they are not searchable as code."),
    })),
    handler: async (args) => {
      const opts: { compact?: boolean; name_contains?: string } = {
        compact: (args.compact as boolean | undefined) ?? true,
      };
      if (args.name_contains) opts.name_contains = args.name_contains as string;
      const all = await listAllRepos(opts);
      if (args.include_conversations === true) return all;

      // The registry holds two namespaces. `conversations/<project>` entries belong to
      // search_conversations and cannot be searched as code, but they dominate the list: measured
      // on a real registry, 418 of 590 entries (71%) were conversation indexes and they carried
      // 86% of the bytes — 34,447 B of 40,196. An agent asking "which repos can I search" paid
      // ~11,000 tokens to receive ~550 tokens of answer.
      //
      // Excluded by default rather than removed: the count is reported so the omission is visible,
      // and include_conversations=true returns the full list unchanged.
      const isConversation = (name: string) => name.startsWith("conversations/");
      if (Array.isArray(all)) {
        const kept = (all as unknown[]).filter((r) =>
          typeof r === "string"
            ? !isConversation(r)
            : !isConversation(String((r as { name?: unknown }).name ?? "")),
        );
        const hidden = all.length - kept.length;
        if (hidden === 0) return kept;
        return { repos: kept, conversation_indexes_hidden: hidden,
          hint: `${hidden} conversation index(es) omitted — pass include_conversations=true to list them, or use search_conversations.` };
      }
      return all;
    },
  } },
  { order: 1214, definition: {
    name: "invalidate_cache",
    category: "indexing",
    searchHint: "clear cache invalidate re-index refresh",
    description: "Clear the index cache for a repository, forcing full re-index on next use",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: (args) => invalidateCache(args.repo as string),
  } },
  { order: 1225, definition: {
    name: "index_file",
    category: "indexing",
    searchHint: "re-index single file update incremental",
    description: "Re-index a single file after editing. Auto-finds repo, skips if unchanged.",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the file to re-index"),
    })),
    handler: (args) => indexFile(args.path as string),
  } },
];
