/**
 * Conversation indexing tool.
 *
 * Scans a directory for JSONL session files, extracts conversation turn symbols,
 * and registers them into the CodeSift index so they are searchable via BM25.
 */

import { readdir, stat, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, basename, resolve } from "node:path";
import { extractConversationSymbols } from "../parser/symbol-extractor.js";
import { saveIndex, loadIndex, getIndexPath } from "../storage/index-store.js";
import { registerRepo } from "../storage/registry.js";
import { buildBM25Index, searchBM25, applyCutoff, type BM25Index } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { embedSymbols } from "./index-tools.js";
import type { CodeIndex, CodeSymbol, FileEntry, RepoMeta } from "../types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function getCurrentHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** Module-level BM25 cache keyed by conversation repo name. */
const bm25Indexes = new Map<string, BM25Index>();

/** Get the cached BM25 index for a conversation repo (used by search tools). */
export function getConversationBM25Index(repoName: string): BM25Index | null {
  return bm25Indexes.get(repoName) ?? null;
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
 * Convert a project root path into Claude Code's per-project conversation path.
 * Claude stores conversation JSONL files under `~/.claude/projects/<encoded-cwd>`.
 */
export function getClaudeConversationProjectPath(
  cwd: string,
  homeDir = getCurrentHomeDir(),
): string {
  return join(homeDir, ".claude", "projects", encodeCwdToClaudePath(resolve(cwd)));
}

function resolveConversationProjectPath(projectPath?: string): string {
  return projectPath ? resolve(projectPath) : getClaudeConversationProjectPath(process.cwd());
}

/**
 * Index all JSONL conversation session files found in `projectPath`.
 *
 * - Filters to `.jsonl` files only
 * - Skips files larger than 10 MB
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

  const allSymbols: CodeSymbol[] = [];
  const fileEntries: FileEntry[] = [];

  let sessionsFound = 0;
  let turnsIndexed = 0;
  let skippedNoiseRecords = 0;
  let compactedSessions = 0;

  // List directory entries — non-recursive, flat scan
  let entries: string[];
  try {
    entries = await readdir(rootPath);
  } catch {
    entries = [];
  }

  const jsonlFiles = entries.filter((name) => name.endsWith(".jsonl"));

  for (const fileName of jsonlFiles) {
    const filePath = join(rootPath, fileName);

    // Size guard
    let fileSize: number;
    try {
      const fileStat = await stat(filePath);
      fileSize = fileStat.size;
    } catch {
      continue;
    }

    if (fileSize > MAX_FILE_SIZE) {
      continue;
    }

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

    sessionsFound++;
    turnsIndexed += turnSymbols.length;
    if (summarySymbols.length > 0) {
      compactedSessions++;
    }

    allSymbols.push(...symbols);

    const entry: FileEntry = {
      path: relPath,
      language: "conversation",
      symbol_count: symbols.length,
      last_modified: Date.now(),
    };
    fileEntries.push(entry);
  }

  // Build and cache BM25 index
  const bm25 = buildBM25Index(allSymbols);
  bm25Indexes.set(repoName, bm25);

  // Persist the code index
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols: allSymbols,
    files: fileEntries,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: allSymbols.length,
    file_count: fileEntries.length,
  };
  await saveIndex(indexPath, codeIndex);

  // Embed conversation symbols in background (non-fatal, fire-and-forget)
  embedSymbols(allSymbols, indexPath, repoName, config).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[codesift] Conversation embedding failed for ${repoName}: ${msg}`);
  });

  // Register in the global registry
  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: allSymbols.length,
    file_count: fileEntries.length,
    updated_at: Date.now(),
  };
  await registerRepo(config.registryPath, meta);

  return {
    sessions_found: sessionsFound,
    turns_indexed: turnsIndexed,
    skipped_noise_records: skippedNoiseRecords,
    compacted_sessions: compactedSessions,
    elapsed_ms: Date.now() - startTime,
  };
}

export interface ConversationSearchResult {
  session_id: string;
  timestamp: string;
  git_branch: string;
  user_question: string;
  assistant_answer: string;
  score: number;
  file: string;
  turn_index: number;
}

export interface SearchConversationsResult {
  results: ConversationSearchResult[];
  total_matches: number;
}

/**
 * Search indexed conversation turns using BM25 full-text search.
 *
 * Requires `indexConversations` to have been called first (populates the BM25 cache).
 */
export async function searchConversations(
  query: string,
  projectPath?: string,
  limit?: number,
): Promise<SearchConversationsResult> {
  const rootPath = resolveConversationProjectPath(projectPath);
  const repoName = `conversations/${basename(rootPath)}`;

  let bm25 = bm25Indexes.get(repoName) ?? null;
  if (!bm25) {
    // Try loading from disk if not in cache
    try {
      const config = loadConfig();
      const indexPath = getIndexPath(config.dataDir, rootPath);
      const codeIndex = await loadIndex(indexPath);
      if (codeIndex && codeIndex.symbols.length > 0) {
        bm25 = buildBM25Index(codeIndex.symbols);
        bm25Indexes.set(repoName, bm25);
      }
    } catch {
      // Index doesn't exist yet
    }
  }
  if (!bm25) {
    return { results: [], total_matches: 0 };
  }

  const config = loadConfig();
  const topK = limit ?? 10;
  const raw = searchBM25(bm25, query, topK, config.bm25FieldWeights);
  const filtered = applyCutoff(raw).slice(0, topK);

  const results: ConversationSearchResult[] = filtered.map((r) => {
    const sym = r.symbol;

    // Extract assistant answer — text after "---" separator in source
    const source = sym.source ?? "";
    const sepIdx = source.indexOf("\n---\n");
    const assistantAnswer = sepIdx >= 0 ? source.slice(sepIdx + 5) : "";

    // Parse docstring: "timestamp | gitBranch" (both optional)
    const docParts = sym.docstring ? sym.docstring.split(" | ") : [];
    const timestamp = docParts[0] ?? "";
    const gitBranch = docParts[1] ?? "";

    // Extract turn_index from symbol id: "...turn_N:line"
    const turnMatch = sym.id.match(/:turn_(\d+):/);
    const turnIndex = turnMatch ? parseInt(turnMatch[1]!, 10) : 0;

    return {
      session_id: sym.parent ?? "",
      timestamp,
      git_branch: gitBranch,
      user_question: sym.name,
      assistant_answer: assistantAnswer,
      score: r.score,
      file: sym.file,
      turn_index: turnIndex,
    };
  });

  return { results, total_matches: results.length };
}

export interface FindConversationsForSymbolResult {
  symbol: { name: string; file: string; kind: string };
  conversations: ConversationSearchResult[];
  session_count: number;
}

/**
 * Find conversation turns that mention a given symbol name.
 *
 * Resolves the symbol in the code repo first, then searches the matching
 * Claude Code conversation directory for discussions of that symbol.
 */
export async function findConversationsForSymbol(
  symbolName: string,
  repo: string,
  limit?: number,
): Promise<FindConversationsForSymbolResult> {
  let resolvedSymbol = { name: symbolName, file: "", kind: "" };
  let projectPath: string | undefined;

  try {
    const { searchSymbols } = await import("./search-tools.js");
    const symbolResults = await searchSymbols(repo, symbolName, {
      include_source: false,
      detail_level: "compact",
      top_k: 10,
    });
    const bestMatch =
      symbolResults.find((r) => r.symbol.name === symbolName) ??
      symbolResults.find((r) => r.symbol.name.toLowerCase() === symbolName.toLowerCase()) ??
      symbolResults[0];

    if (bestMatch) {
      resolvedSymbol = {
        name: bestMatch.symbol.name,
        file: bestMatch.symbol.file,
        kind: bestMatch.symbol.kind,
      };
    }
  } catch {
    // Fall back to plain-text search using the provided symbol name.
  }

  try {
    const { getRepo } = await import("../storage/registry.js");
    const config = loadConfig();
    const repoMeta = await getRepo(config.registryPath, repo);
    if (repoMeta) {
      projectPath = getClaudeConversationProjectPath(repoMeta.root);
    }
  } catch {
    // Fall back to the current project's conversations if repo lookup fails.
  }

  const { results } = await searchConversations(resolvedSymbol.name, projectPath, limit ?? 5);

  const uniqueSessions = new Set(results.map((r) => r.session_id));

  return {
    symbol: resolvedSymbol,
    conversations: results,
    session_count: uniqueSessions.size,
  };
}

/**
 * Encode a filesystem path for use as a Claude project directory name.
 * Claude stores per-project files under `~/.claude/projects/<encoded-cwd>`,
 * where each `/` in the path is replaced with `-`.
 */
export function encodeCwdToClaudePath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Install a session-end hook into `<projectRoot>/.claude/settings.local.json`.
 *
 * The hook runs `codesift index-conversations --quiet` whenever Claude stops,
 * keeping the conversation index up-to-date automatically. Idempotent — will
 * not add a duplicate if the codesift hook is already present.
 */
export async function installSessionEndHook(projectRoot: string): Promise<void> {
  const settingsDir = join(projectRoot, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");

  const hookEntry = {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: "codesift index-conversations --quiet",
      },
    ],
  };

  let settings: Record<string, unknown> = {};
  try {
    const content = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Ensure hooks.Stop array exists
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const hooksObj = settings.hooks as Record<string, unknown[]>;
  if (!Array.isArray(hooksObj.Stop)) {
    hooksObj.Stop = [];
  }

  // Check if codesift hook already exists (idempotent)
  const existing = hooksObj.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
  if (existing.some((h) => h.hooks?.some((hk) => hk.command?.includes("codesift")))) {
    return; // Already installed
  }

  existing.push(hookEntry);

  // Write atomically
  await mkdir(settingsDir, { recursive: true });
  const tmpPath = settingsPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(settings, null, 2));
  await rename(tmpPath, settingsPath);

  console.error("CodeSift: conversation index hook installed in .claude/settings.local.json");
}

/**
 * Auto-discover and index conversation files for the current project at startup.
 *
 * Looks up `~/.claude/projects/<encoded-cwd>` for JSONL session files,
 * indexes them incrementally, then installs the session-end hook so the
 * index stays fresh going forward. Silently does nothing when no conversation
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

  // Index conversations (incremental — skips unchanged files)
  await indexConversations(conversationsDir);

  // Install session-end hook
  await installSessionEndHook(cwd);
}
