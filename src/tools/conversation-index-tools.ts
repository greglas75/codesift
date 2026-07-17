import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { extractConversationSymbols } from "../parser/symbol-extractor.js";
import { saveIndex, getIndexPath } from "../storage/index-store.js";
import { registerRepo } from "../storage/registry.js";
import { buildBM25Index } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { embedSymbols } from "./index-tools.js";
import { setConversationBM25Index } from "./conversation-cache.js";
import {
  getClaudeConversationProjectPath,
  resolveConversationProjectPath,
} from "./conversation-paths.js";
import type { CodeIndex, CodeSymbol, FileEntry, RepoMeta } from "../types.js";

interface ConversationScan {
  symbols: CodeSymbol[];
  files: FileEntry[];
  sessions: number;
  turns: number;
  compacted: number;
}

export interface IndexConversationsResult {
  /** Number of JSONL session files found and processed. */
  sessions_found: number;
  /** Total conversation_turn symbols indexed across all sessions. */
  turns_indexed: number;
  /** Number of noise records skipped (tool results, etc.). */
  skipped_noise_records: number;
  /** Number of sessions that contained compacted summaries. */
  compacted_sessions: number;
  /** Wall-clock time for the entire operation (ms). */
  elapsed_ms: number;
}


/**
 * Index all JSONL conversation session files found in `projectPath`.
 *
 * - Filters to `.jsonl` files only
 * - Processes session files regardless of size
 * - Extracts conversation_turn symbols via `extractConversationSymbols`
 * - Saves to the CodeSift index store and registers in the registry
 * - Caches the BM25 index in module memory for search use
 */
export async function indexConversations(
  projectPath?: string,
): Promise<IndexConversationsResult> {
  const startTime = Date.now();
  const rootPath = resolveConversationProjectPath(projectPath);
  const config = loadConfig();

  // Derive repo name: "conversations/<folder>"
  const repoName = `conversations/${basename(rootPath)}`;
  const indexPath = getIndexPath(config.dataDir, rootPath);

  const scan = await scanConversationFiles(rootPath, repoName);
  await persistConversationIndex(rootPath, repoName, indexPath, scan);

  return {
    sessions_found: scan.sessions,
    turns_indexed: scan.turns,
    skipped_noise_records: 0,
    compacted_sessions: scan.compacted,
    elapsed_ms: Date.now() - startTime,
  };
}

async function scanConversationFiles(rootPath: string, repoName: string): Promise<ConversationScan> {
  let entries: string[];
  try {
    entries = await readdir(rootPath);
  } catch {
    entries = [];
  }

  const scan: ConversationScan = { symbols: [], files: [], sessions: 0, turns: 0, compacted: 0 };
  for (const fileName of entries.filter((name) => name.endsWith(".jsonl"))) {
    const filePath = join(rootPath, fileName);

    // Read and extract
    let source: string;
    try {
      source = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const relPath = relative(rootPath, filePath);
    const symbols = extractConversationSymbols(source, relPath, repoName);

    const turnSymbols = symbols.filter((s) => s.kind === "conversation_turn");
    const summarySymbols = symbols.filter((s) => s.kind === "conversation_summary");

    scan.sessions++;
    scan.turns += turnSymbols.length;
    if (summarySymbols.length > 0) scan.compacted++;
    scan.symbols.push(...symbols);

    const entry: FileEntry = {
      path: relPath,
      language: "conversation",
      symbol_count: symbols.length,
      last_modified: Date.now(),
    };
    scan.files.push(entry);
  }
  return scan;
}

async function persistConversationIndex(
  rootPath: string,
  repoName: string,
  indexPath: string,
  scan: ConversationScan,
): Promise<void> {
  const config = loadConfig();
  const bm25 = buildBM25Index(scan.symbols);
  setConversationBM25Index(repoName, bm25);
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols: scan.symbols,
    files: scan.files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: scan.symbols.length,
    file_count: scan.files.length,
  };
  await saveIndex(indexPath, codeIndex);
  embedSymbols(scan.symbols, indexPath, repoName, config).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[codesift] Conversation embedding failed for ${repoName}: ${msg}`);
  });

  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: scan.symbols.length,
    file_count: scan.files.length,
    updated_at: Date.now(),
  };
  await registerRepo(config.registryPath, meta);
}

/**
 * Retired compatibility shim. Older versions installed a session-end hook into
 * `<projectRoot>/.claude/settings.local.json` that spawned
 * `codesift index-conversations --quiet`. That hook was prone to orphaned
 * background processes, so conversation indexing is now manual.
 */
export async function installSessionEndHook(projectRoot: string): Promise<void> {
  void projectRoot;
}

/**
 * Auto-discover and index conversation files for the current project at startup.
 *
 * Looks up `~/.claude/projects/<encoded-cwd>` for JSONL session files,
 * indexes the directory, then invokes the retired session-end hook shim.
 * Silently does nothing when no conversation
 * directory exists for the project.
 */
export async function autoDiscoverConversations(cwd: string): Promise<void> {
  const conversationsDir = getClaudeConversationProjectPath(cwd);

  try {
    const dirStat = await stat(conversationsDir);
    if (!dirStat.isDirectory()) return;
  } catch {
    return; // Directory doesn't exist — no conversations for this project
  }

  // Index conversations from the discovered directory.
  await indexConversations(conversationsDir);

  // Install session-end hook
  await installSessionEndHook(cwd);
}
