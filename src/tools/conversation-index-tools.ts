import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { extractConversationSymbols } from "../parser/symbol-extractor.js";
import {
  saveIndex, getIndexPath, loadIndex, loadIndexSummary, saveIncremental, removeFileFromIndex,
} from "../storage/index-store.js";
import { registerRepo } from "../storage/registry.js";
import { buildBM25IndexYielding, updateBM25ForFile } from "../search/bm25.js";
import { loadBM25Index, saveBM25Index } from "../search/bm25-store.js";
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
  /**
   * True when nothing was re-read because every `.jsonl` matched its recorded mtime.
   *
   * Additive and optional so a caller that does not know about it still reads the counts. It exists
   * because a skip cannot report `compacted_sessions` — that is not stored — and a silent 0 there
   * would be indistinguishable from "scanned, found none".
   */
  /** True when only the changed sessions were re-extracted rather than the whole directory. */
  incremental?: boolean;
  /** How many sessions were re-extracted or dropped on an incremental pass. */
  changed_sessions?: number;
  unchanged?: boolean;
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
  options?: { embed?: boolean },
): Promise<IndexConversationsResult> {
  const startTime = Date.now();
  const rootPath = resolveConversationProjectPath(projectPath);
  const config = loadConfig();

  // Derive repo name: "conversations/<folder>"
  const repoName = `conversations/${basename(rootPath)}`;
  const indexPath = getIndexPath(config.dataDir, rootPath);

  // Nothing detected change, so every call did everything: read every .jsonl, re-extract every turn,
  // rebuild the BM25 index. `autoDiscoverConversations` runs this on server start, and the largest
  // conversation directory here is 160,626 turns / 72 MB of source whose BM25 build alone measures
  // 35.8 s — paid on every spawn, for a directory that usually gained one session or nothing.
  //
  // It is also what made persisting the index pointless: `persistConversationIndex` stamps
  // `updated_at: Date.now()`, so an unconditional rescan invalidated its own cache every time.
  // `embed` is the ONE thing a skip cannot stand in for. Embedding is opt-in and only an explicit
  // `index_conversations` asks for it, so skipping on "the files did not change" silently drops the
  // work the caller invoked the tool to get — the directory being unchanged says nothing about
  // whether its vectors exist. Found by the cross-model review of this release; it is a regression
  // the fast paths introduced, not pre-existing behaviour.
  const wantsEmbed = options?.embed ?? true;
  const unchanged = wantsEmbed ? null : await conversationsUnchanged(rootPath, indexPath);
  if (unchanged) {
    return {
      sessions_found: unchanged.sessions,
      turns_indexed: unchanged.turns,
      skipped_noise_records: 0,
      compacted_sessions: 0,
      elapsed_ms: Date.now() - startTime,
      unchanged: true,
    };
  }

  // Re-extract only the sessions that moved.
  //
  // The skip above covers a directory nothing touched, which is every project except the one being
  // worked in. The ACTIVE project's directory changes on every turn, so for it the skip can never
  // fire — and a full pass over the largest one here measures 156 s (211 sessions, 164,500 turns).
  // `autoDiscoverConversations` runs on every server spawn, so that was paid per session, on one
  // thread, in the process whose event loop is the bottleneck.
  //
  // A conversation log is append-only and sessions are independent files, which is the case
  // `updateBM25ForFile` already exists for: swap the changed file's symbols in place rather than
  // rebuilding the vocabulary for all 164,500 turns.
  // Same reason the skip is gated above: `incrementalConversationUpdate` already refuses when embedding
  // was asked for (its first guard), and this makes that refusal visible at the call site rather than
  // only inside the callee.
  const incremental = wantsEmbed
    ? null
    : await incrementalConversationUpdate(rootPath, repoName, indexPath, options);
  if (incremental) {
    return {
      sessions_found: incremental.sessions,
      turns_indexed: incremental.turns,
      skipped_noise_records: 0,
      // Recomputed from the merged symbols rather than reported as 0. It is one pass over symbols this
      // function already holds, and a silent 0 is indistinguishable from "scanned, found none".
      compacted_sessions: incremental.compacted,
      elapsed_ms: Date.now() - startTime,
      incremental: true,
      changed_sessions: incremental.changed,
    };
  }

  const scan = await scanConversationFiles(rootPath, repoName);
  // Explicit call embeds by default; auto-discovery passes embed:false (see below).
  await persistConversationIndex(rootPath, repoName, indexPath, scan, { embed: wantsEmbed });

  return {
    sessions_found: scan.sessions,
    turns_indexed: scan.turns,
    skipped_noise_records: 0,
    compacted_sessions: scan.compacted,
    elapsed_ms: Date.now() - startTime,
  };
}

/**
 * Counts from the stored index when the directory is byte-for-byte the same, otherwise null.
 *
 * Compares the SET of `.jsonl` files and each one's mtime against what the index recorded. A
 * conversation log is append-only, so an appended turn moves the mtime; a new session adds a path;
 * a deleted one removes it. Any of those, or a summary that cannot be read, means rescan — the
 * conservative direction, since the cost of rescanning is time and the cost of skipping wrongly is
 * a search that cannot see a conversation.
 *
 * `compacted_sessions` is not stored and cannot be recovered here, so a skip reports 0 for it rather
 * than a number it would have to invent; `unchanged: true` in the result says which kind of answer
 * this is.
 */
async function conversationsUnchanged(
  rootPath: string,
  indexPath: string,
): Promise<{ sessions: number; turns: number } | null> {
  let summary: Awaited<ReturnType<typeof loadIndexSummary>>;
  try {
    summary = await loadIndexSummary(indexPath);
  } catch {
    return null;
  }
  if (!summary || summary.files.length === 0) return null;

  let entries: string[];
  try {
    entries = (await readdir(rootPath)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (entries.length !== summary.files.length) return null;

  const recorded = new Map<string, number>();
  for (const file of summary.files) {
    const mtime = file.mtime_ms ?? 0;
    // An index written before mtimes were recorded cannot be compared — rescan rather than guess.
    if (mtime === 0) return null;
    recorded.set(file.path, mtime);
  }

  for (const name of entries) {
    const expected = recorded.get(name);
    if (expected === undefined) return null;
    try {
      if ((await stat(join(rootPath, name))).mtimeMs !== expected) return null;
    } catch {
      return null;
    }
  }
  // Indexed SYMBOLS, which is turns plus one `conversation_summary` per compacted session. The split
  // is not stored per file, and loading every symbol to recover it would cost more than this whole
  // skip saves — so the number is named honestly on `unchanged` rather than silently differing from a
  // scanned pass by the compacted count.
  let symbols = 0;
  for (const file of summary.files) symbols += file.symbol_count;
  return { sessions: summary.files.length, turns: symbols };
}

/**
 * Swap the changed sessions into the stored index, or null when that cannot be done safely.
 *
 * Returns null — meaning "fall back to a full pass" — whenever anything is not certainly known: no
 * stored index, an index written before mtimes were recorded, no persisted BM25 index to amend, or
 * too much of the directory changed for amending to be cheaper than rebuilding. Falling back is
 * always correct; amending on a wrong assumption produces an index that searches cleanly and is
 * missing turns.
 *
 * Embeddings deliberately stay on the full path. They are opt-in, they are the expensive part when
 * enabled, and an incremental embed needs its own per-symbol accounting rather than a file-level one.
 */
/**
 * Largest share of a conversation directory that is still worth amending file by file.
 *
 * Measured 2026-09-27 on a 15,838-symbol / 788-session index, amending against one clean
 * `buildBM25Index` (4,211 ms):
 *
 *     5%   39 files    183 ms   amend wins  x22.96
 *    25%  197 files    200 ms   amend wins  x21.00
 *    50%  394 files  1,639 ms   amend wins   x2.57
 *    75%  591 files 14,037 ms   REBUILD wins x0.30
 *   100%  788 files 22,888 ms   REBUILD wins x0.18
 *
 * The crossover is between 50% and 75%, and the amend cost grows SUPERLINEARLY — each amended file is
 * a remove-then-add over the postings maps every other file shares, so the churn compounds. That is
 * why the bound is conservative rather than set at the crossover: past it the penalty is not a few
 * percent, it is 5x.
 *
 * `centrality` is NOT a reason for this bound, though an earlier version of this comment said it was:
 * a conversation index has **zero** centrality entries (measured on two of them), because there is no
 * import graph in a chat log. `compacted_sessions` is not a reason either any more — it is recomputed
 * from the merged symbols.
 */
const CONVERSATION_AMEND_MAX_SHARE = 0.5;

async function incrementalConversationUpdate(
  rootPath: string,
  repoName: string,
  indexPath: string,
  options?: { embed?: boolean },
): Promise<{ sessions: number; turns: number; changed: number; compacted: number } | null> {
  if (options?.embed) return null;

  let stored: CodeIndex | null;
  try {
    stored = await loadIndex(indexPath);
  } catch {
    return null;
  }
  if (!stored || stored.files.length === 0 || stored.symbols.length === 0) return null;

  let entries: string[];
  try {
    entries = (await readdir(rootPath)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }

  const recorded = new Map<string, FileEntry>();
  for (const file of stored.files) {
    if ((file.mtime_ms ?? 0) === 0) return null;
    recorded.set(file.path, file);
  }

  const present = new Set(entries);
  const removed = [...recorded.keys()].filter((path) => !present.has(path));
  const changed: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(rootPath, name))).mtimeMs;
    } catch {
      return null;
    }
    if (recorded.get(name)?.mtime_ms !== mtimeMs) changed.push({ path: name, mtimeMs });
  }
  if (changed.length === 0 && removed.length === 0) return null; // the caller's skip already handled this

  // Past this share of the directory, amending stops being cheaper than one clean pass: every amended
  // file costs a remove-then-add over the shared postings maps, which churns the vocabulary, while a
  // full build ingests each symbol once. The bound is measured, not guessed — see
  // CONVERSATION_AMEND_MAX_SHARE.
  if (changed.length + removed.length > Math.max(1, Math.floor(entries.length * CONVERSATION_AMEND_MAX_SHARE))) {
    return null;
  }

  const bm25 = await loadBM25Index(indexPath, stored);
  if (!bm25) return null;

  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const symbol of stored.symbols) {
    const list = symbolsByFile.get(symbol.file);
    if (list) list.push(symbol);
    else symbolsByFile.set(symbol.file, [symbol]);
  }

  const files = new Map(recorded);
  for (const path of removed) {
    updateBM25ForFile(bm25, path, []);
    symbolsByFile.delete(path);
    files.delete(path);
  }
  for (const { path, mtimeMs } of changed) {
    let source: string;
    try {
      source = await readFile(join(rootPath, path), "utf-8");
    } catch {
      return null;
    }
    const symbols = extractConversationSymbols(source, path, repoName);
    updateBM25ForFile(bm25, path, symbols);
    symbolsByFile.set(path, symbols);
    files.set(path, {
      path,
      language: "conversation",
      symbol_count: symbols.length,
      last_modified: mtimeMs,
      mtime_ms: mtimeMs,
    });
  }

  const mergedSymbols: CodeSymbol[] = [];
  let compacted = 0;
  let turns = 0;
  for (const list of symbolsByFile.values()) {
    mergedSymbols.push(...list);
    // `turns_indexed` counts TURNS, and a compacted session also carries one `conversation_summary`
    // symbol. Reporting `mergedSymbols.length` over-counted by exactly the number of compacted
    // sessions — 15,894 against the full path's 15,887 on this machine, with compacted = 7.
    for (const symbol of list) {
      if (symbol.kind === "conversation_turn") turns++;
      else if (symbol.kind === "conversation_summary") compacted++;
    }
  }
  const mergedFiles = [...files.values()];

  // Write only the rows that moved. `saveIndex` rewrites every symbol of the repo: measured on a
  // 15,838-symbol conversation index, 1,494 ms against **0-1 ms** for `saveIncremental` on one file —
  // and the whole point of this path is that two sessions changed. Deletions go through
  // `removeFileFromIndex`, which also drops the `files[]` row; `saveIncremental` would leave it.
  for (const path of removed) await removeFileFromIndex(indexPath, path);
  for (const { path } of changed) {
    await saveIncremental(indexPath, path, symbolsByFile.get(path) ?? [], files.get(path));
  }

  // Both writers stamp `updated_at` themselves, so the value has to be read back rather than assumed:
  // the BM25 header must carry what the database now says, or every later search rejects the file and
  // rebuilds — the exact state this path exists to leave behind.
  let updatedAt = Date.now();
  try {
    updatedAt = (await loadIndexSummary(indexPath))?.updated_at ?? updatedAt;
  } catch {
    return null; // cannot prove what the index says; a full pass will rewrite both consistently
  }
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols: mergedSymbols,
    files: mergedFiles,
    created_at: stored.created_at,
    updated_at: updatedAt,
    symbol_count: mergedSymbols.length,
    file_count: mergedFiles.length,
  };
  await saveBM25Index(indexPath, bm25, codeIndex);
  setConversationBM25Index(repoName, bm25, codeIndex.updated_at);
  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: codeIndex.symbol_count,
    file_count: codeIndex.file_count,
    updated_at: codeIndex.updated_at,
  };
  await registerRepo(loadConfig().registryPath, meta);

  return {
    sessions: mergedFiles.length,
    turns,
    changed: changed.length + removed.length,
    compacted,
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
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
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
      // The FILE's mtime, not the scan's clock. This was `Date.now()`, which records when the
      // scanner ran and therefore cannot be compared against anything on disk — so a stored
      // conversation index could never be shown to be current, and every scan was a full rescan.
      // `mtime_ms` is the field the type already documents as "for incremental skip".
      last_modified: mtimeMs,
      mtime_ms: mtimeMs,
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
  options?: { embed?: boolean },
): Promise<void> {
  const config = loadConfig();
  const bm25 = await buildBM25IndexYielding(scan.symbols);
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
  // Persist the BM25 index beside the code index, with the SAME `codeIndex` object that was just
  // written — `saveBM25Index` stamps its header from it, and `loadBM25Index` refuses a header that
  // disagrees. Writing it here rather than from the search path is what lets a search LOAD the index
  // (4.3x to 20x faster than rebuilding, measured on this machine's three largest conversation
  // directories) instead of tokenising the whole corpus again.
  await saveBM25Index(indexPath, bm25, codeIndex);

  // Embedding conversations is OPT-IN. This used to fire unconditionally and
  // unawaited on every server start (autoDiscoverConversations → here), so each
  // of N concurrent MCP servers began embedding the whole ~/.claude/projects
  // history (6+ GB of JSONL) in the background. The resulting Float32Arrays live
  // OUTSIDE the V8 heap, so --max-old-space-size cannot bound them: a single
  // process was measured at 53 GB RSS, and with one server per editor session
  // that alone exhausted a 128 GB machine.
  //
  // The BM25 index built above is what search_conversations actually needs for
  // lexical hits, and it is cheap. Semantic conversation search now requires an
  // explicit index_conversations call rather than happening behind your back.
  if (options?.embed) {
    embedSymbols(scan.symbols, indexPath, repoName, config).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Conversation embedding failed for ${repoName}: ${msg}`);
    });
  }

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
  // Startup path: BM25 only. Embedding 6+ GB of chat history in the background
  // on every server spawn is what blew the machine's RAM.
  await indexConversations(conversationsDir, { embed: false });

  // Install session-end hook
  await installSessionEndHook(cwd);
}
