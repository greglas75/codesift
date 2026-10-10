import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { recordEmbeddingRun } from "../../storage/embedding-health.js";
import { EXTRACTOR_VERSIONS } from "../index-shared.js";
import { getLanguageForExtension } from "../../parser/parser-manager.js";
import { saveIndex, loadIndex, loadIndexSummary, getIndexPath } from "../../storage/index-store.js";
import { trackExternalWriter } from "../../storage/external-writers.js";
import { clearTsconfigCache } from "../../utils/tsconfig-paths.js";
import {
  registerRepo,
  listRepos as listRegistryRepos,
  removeRepo,
  getRepo,
  getRepoName,
  updateRepoMeta,
} from "../../storage/registry.js";
import { buildBM25IndexYielding } from "../../search/bm25.js";
import { loadConfig } from "../../config.js";
import { walkDirectory } from "../../utils/walk.js";
import { canonicalPath, findWorkingTree } from "../../utils/worktree.js";
import { HASH_SNAPSHOT_VERSION, type FileHashSnapshot } from "../../storage/hash-snapshot.js";
import type { CodeIndex, CodeSymbol, FileEntry, RepoMeta } from "../../types.js";
import { activeWatchers, bm25Indexes, BM25_PERSIST_MIN_BUILD_MS, codeIndexes, invalidateEmbeddingCaches, lastFullIndexAt, rememberBM25Index } from "./state.js";
import { parseFiles, propagateDirtySignatures, embedSymbols, embedChunks } from "./parse.js";
import { drainLegacyHashQueue, loadIndexSnapshot, saveIndexSnapshot, sha1OfFile } from "./snapshots.js";
import { setupWatcher } from "./watcher.js";
import { validateAndMergeFolderWalk } from "./folder-merge.js";
import type { IndexFolderResult } from "./types.js";
import {
  runEmbeddingChildProcess,
  runIndexChild,
  shouldIndexOutOfProcess,
  type IndexFolderReport,
} from "./out-of-process.js";

export type { IndexFolderResult } from "./types.js";

const INDEX_FOLDER_REDUNDANT_WINDOW_MS = 60_000;
/**
 * Backstop against a pathological walk — NOT a budget, and not a number any
 * real repository should approach.
 *
 * It was 50,000 with no stated rationale, and two repos sat exactly on it:
 * tgm-mobi and Mobi3, both ~89% Composer `vendor/`. Dependency code was
 * consuming the cap and pushing first-party source OUT of the index, so those
 * repos were silently incomplete rather than merely slow. With `vendor/`
 * excluded the largest genuine repo here is tgm-survey-platform at 14,439
 * files, so 200,000 puts the ceiling an order of magnitude above anything real
 * while still stopping a runaway walk.
 *
 * It stays finite because the index is ONE JSON blob per repo and the write
 * path re-serialises all of it: tgm-survey-platform's 14k files already cost
 * 269 MB and ~1.8s per parse. An unbounded cap would trade silent truncation
 * for an index too expensive to write, which is not a better failure.
 */
const DEFAULT_MAX_FILES = 200_000;

/**
 * In-flight background embedding runs, keyed by repo.
 *
 * The embedding chain is deliberately not awaited by indexFolder (it can take
 * minutes and must not block an MCP response), but nothing used to stop a
 * SECOND run from starting while the first was still going. With a file watcher
 * attached, every save spawned another detached chain, each holding the parsed
 * symbol set, every file's chunk text, and a second copy of that text inside
 * batchEmbed — concurrently. One observed `codesift index` process reached
 * 163 GB RSS this way; the single-run cost is ~8 GB.
 *
 * Runs for a repo are now serialised: a request that arrives while one is
 * active chains onto it instead of running beside it. Peak memory becomes the
 * cost of ONE run regardless of how often files change.
 */
const embeddingRuns = new Map<string, Promise<void>>();

function scheduleEmbedding(repoName: string, run: () => Promise<void>): Promise<void> {
  const prev = embeddingRuns.get(repoName);
  const next = (prev ?? Promise.resolve())
    .then(run, run) // a failed predecessor must not cancel the follow-up
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] Background embedding failed for ${repoName}: ${msg}`);
    })
    .finally(() => {
      // Only clear if we are still the newest run for this repo.
      if (embeddingRuns.get(repoName) === next) embeddingRuns.delete(repoName);
    });
  embeddingRuns.set(repoName, next);
  return next;
}

/**
 * Await every background embedding run still in flight.
 *
 * One-shot callers (the CLI) must call this before exiting: `main()` force-exits
 * on completion, which killed the detached chain mid-flight and left the repo
 * with NO embeddings written and no error reported.
 */
export async function awaitPendingEmbeddings(): Promise<void> {
  while (embeddingRuns.size > 0) {
    await Promise.allSettled([...embeddingRuns.values()]);
  }
}


async function enableReportedFrameworks(frameworks: Iterable<string>, repoName: string): Promise<void> {
  const list = [...frameworks];
  if (list.length === 0) return;
  // Lazy import to avoid circular dep: index-tools → register-tools → tool handlers → index-tools
  const { enableFrameworkToolBundle } = await import("../../register-tools.js");
  for (const fw of list) {
    const enabled = enableFrameworkToolBundle(fw);
    if (enabled.length > 0) {
      console.error(`[codesift] auto-enabled ${enabled.length} ${fw} tools for ${repoName}: ${enabled.join(", ")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Out-of-process indexing (daemon only) — see out-of-process.ts
// ---------------------------------------------------------------------------

/**
 * Runs keyed by root + options, so an identical request that arrives while one is in flight joins
 * it instead of starting a second child over the same tree. The workload that makes this matter:
 * a new worktree is typically requested by an agent's `index_folder`, by `ensureIndexFresh` on its
 * first tool call, and by a sibling session at once — in-process those raced into the same
 * database; as children they would also each hold a full copy of the index in memory.
 *
 * A joined caller gets a result that started before its own request. That is the same freshness an
 * in-flight in-process run gave, and the watcher / freshness check pick up anything later.
 */
interface ChildRun {
  promise: Promise<IndexFolderResult>;
  /** Any caller asking for a watcher gets one — a joined `index_folder` must not inherit the
   *  `watch: false` of the `ensureIndexFresh` call it happened to join. */
  wants: { watch: boolean };
}
const childRunsByKey = new Map<string, ChildRun>();
/** The latest run per root. A request with DIFFERENT options queues behind it rather than writing
 *  the same SQLite file concurrently from a second process. */
const childRunTailByRoot = new Map<string, Promise<unknown>>();

function indexFolderInChild(
  folderPath: string,
  rootPath: string,
  repoName: string,
  options: Parameters<typeof indexFolder>[1],
): Promise<IndexFolderResult> {
  let rootKey: string;
  try { rootKey = canonicalPath(rootPath); } catch { rootKey = rootPath; }
  const childOptions = {
    incremental: options?.incremental,
    include_paths: options?.include_paths,
    max_files: options?.max_files,
    force: options?.force,
  };
  // Only what changes the OUTCOME is in the key. `incremental` is accepted and never read (the
  // mtime/sha reuse below always runs), and `force` only bypasses the short-circuit, which has
  // already been decided in this process — so `ensureIndexFresh`'s `{incremental: true}` joins an
  // agent's plain `index_folder` of the same tree instead of queueing a second full run behind it.
  const key = `${rootKey}\0${JSON.stringify([childOptions.include_paths ?? null, childOptions.max_files ?? null])}`;
  const joined = childRunsByKey.get(key);
  if (joined) {
    if (options?.watch !== false) joined.wants.watch = true;
    return joined.promise;
  }

  const prev = childRunTailByRoot.get(rootKey) ?? Promise.resolve();
  const wants = { watch: options?.watch !== false };
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      let response: Awaited<ReturnType<typeof runIndexChild>>;
      // Only the running child is an external writer — from its spawn, not from the wait for a slot,
      // and not the adoption tail: registering either would make an incremental write wait on work
      // that is not writing, and on anything in the tail that itself writes this index, forever.
      // Both spellings of the path: the registry may hold the canonical root (`/private/tmp/…`)
      // while this call got a symlink.
      const { dataDir } = loadConfig();
      const child = runIndexChild({ path: folderPath, options: childOptions }, {
        onSpawn: (outcome) => {
          for (const indexPath of new Set([getIndexPath(dataDir, rootPath), getIndexPath(dataDir, rootKey)])) {
            trackExternalWriter(indexPath, outcome);
          }
        },
      });
      try {
        response = await child;
      } catch (err) {
        // The child may have committed the index before failing in its tail (registry write,
        // framework detection, an OOM kill): the database is new while a resident copy here is old,
        // and a resident index is answered without consulting the database. The in-process path
        // dropped the cache before saving, so a post-save throw left nothing stale; keep that.
        dropResidentCaches(repoName);
        throw err;
      }
      await adoptChildIndex(response.result, response.report, wants.watch);
      return response.result;
    });
  const record: ChildRun = { promise: run, wants };
  childRunsByKey.set(key, record);
  childRunTailByRoot.set(rootKey, run);
  void run
    .finally(() => {
      if (childRunsByKey.get(key) === record) childRunsByKey.delete(key);
      if (childRunTailByRoot.get(rootKey) === run) childRunTailByRoot.delete(rootKey);
    })
    .catch(() => undefined);
  return run;
}

function dropResidentCaches(repoName: string): void {
  codeIndexes.delete(repoName);
  bm25Indexes.delete(repoName);
  invalidateEmbeddingCaches(repoName);
  clearTsconfigCache();
}

/**
 * Bring this process's state in line with what a child just wrote, then do what the in-process
 * path would have done at its tail — and ONLY what it would have done: a seeded or rejected run
 * schedules no embedding, starts no watcher and arms no short-circuit in-process, so `completed`
 * gates all three here.
 *
 * The caches are dropped whatever the outcome. A child that wrote anything — a seed, a catch-up, a
 * full index — has made every resident copy of that repo stale, and a resident index is answered
 * without consulting the database, so nothing else would ever notice.
 */
async function adoptChildIndex(
  result: IndexFolderResult,
  report: IndexFolderReport,
  watch: boolean,
): Promise<void> {
  const repoName = result.repo;
  const rootPath = result.root;
  dropResidentCaches(repoName);

  if (!report.completed) return;
  const config = loadConfig();
  const indexPath = report.index_path ?? getIndexPath(config.dataDir, rootPath);

  // In-process this was `scheduleEmbedding(… embedSymbols + embedChunks …)`. Same queue, so runs for
  // one repo still serialise (the 163 GB lesson above) — the work just happens in embed-child, and
  // the vectors it wrote replace whatever this process had cached.
  if (config.embeddingProvider && process.env["CODESIFT_EMBED_OUT_OF_PROCESS"] !== "1") {
    void scheduleEmbedding(repoName, async () => {
      const ok = await runEmbeddingChildProcess(repoName, rootPath, indexPath);
      // The child's own record dies with it; /health reads this process's.
      recordEmbeddingRun(repoName, ok, ok ? undefined : "embed child failed (reason in the daemon's stderr log)");
      invalidateEmbeddingCaches(repoName);
    });
  }

  if (watch) await setupWatcher(rootPath, repoName, indexPath);
  try {
    await enableReportedFrameworks(report.frameworks ?? [], repoName);
  } catch {
    // Non-fatal, as in-process.
  }
  lastFullIndexAt.set(rootPath, Date.now());
}

function getDefaultMaxFiles(): number {
  const envVal = process.env.CODESIFT_MAX_FILES;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_FILES;
}

/** Test-only — clear short-circuit state. */
export function resetIndexFolderRedundancyForTesting(): void {
  lastFullIndexAt.clear();
}


/**
 * A subdirectory of a LINKED WORKTREE is indexed as the worktree itself.
 *
 * Passing `<worktree>/apps` used to produce a separate repo named after the basename —
 * `local/apps`, `local/src`, `local/lib` — which collides across every repo on the machine and
 * accumulates registry entries that outlive the tree. It also missed the seed entirely: the parent
 * lookup keys off the worktree root, so a subdirectory fell through to a full parse (measured on
 * this repo: 12.0s for `<wt>/src` against 2.9s for the seeded worktree root).
 *
 * Redirecting is strictly better than refusing: the caller wanted their tree indexed, and the
 * worktree root is a superset of the subdirectory, so nothing they asked for is lost. The result
 * carries `redirected_from` so this is never silent.
 *
 * ONLY for linked worktrees. A subdirectory of an ordinary checkout is left alone — someone
 * indexing `~/DEV/monorepo/packages/foo` may well mean exactly that, and widening it to the whole
 * monorepo would be a surprise, not a fix.
 */
function worktreeRootFor(requested: string): string {
  try {
    const tree = findWorkingTree(requested);
    if (!tree?.linked) return requested;
    if (canonicalPath(tree.root) === canonicalPath(requested)) return requested;
    return tree.root;
  } catch {
    return requested;   // never let path probing break indexing
  }
}

export async function indexFolder(
  folderPath: string,
  options?: {
    incremental?: boolean | undefined;
    include_paths?: string[] | undefined;
    watch?: boolean | undefined;
    /**
     * Cap on files indexed in a single pass. When the walker hits this, it
     * returns partial results with a warning rather than blowing through
     * memory. Default: DEFAULT_MAX_FILES (or CODESIFT_MAX_FILES env var).
     */
    max_files?: number | undefined;
    /**
     * Bypass the watcher-active short-circuit (see lastFullIndexAt). Used by
     * indexRepo for fresh clones where defensive reindex is correct.
     */
    force?: boolean | undefined;
    /**
     * Internal — set only by `src/cli/index-child.ts`. Marks this call as running inside an index
     * child: what the daemon must act on afterwards (frameworks to enable, whether the full path
     * completed) is recorded here instead of being applied to a process that is about to exit.
     */
    report?: IndexFolderReport | undefined;
  },
): Promise<IndexFolderResult> {
  if (!folderPath || typeof folderPath !== "string") {
    throw new Error("folderPath is required and must be a non-empty string");
  }

  const requestedPath = resolve(folderPath);
  const rootPath = worktreeRootFor(requestedPath);
  const redirected = rootPath !== requestedPath;
  const repoName = getRepoName(rootPath);

  // Short-circuit: if a watcher is already keeping the index for this root
  // live and we re-indexed recently, return a skipped status instead of
  // walking the filesystem again.
  if (!options?.force) {
    const lastTs = lastFullIndexAt.get(rootPath);
    const watcher = activeWatchers.get(repoName);
    if (watcher && lastTs && Date.now() - lastTs < INDEX_FOLDER_REDUNDANT_WINDOW_MS) {
      return {
        repo: repoName,
        root: rootPath,
        file_count: 0,
        symbol_count: 0,
        duration_ms: 0,
        status: "skipped",
        reason: "watcher active, recent index",
        last_indexed: new Date(lastTs).toISOString(),
        hint: "pass force=true to override",
      };
    }
  }

  // In the daemon, everything below — seed copy, walk, parse, whole-index write, BM25 build, and the
  // embedding pass after it — runs in a child process instead of on the thread serving every
  // client. See out-of-process.ts for the measurements. The short-circuit above stays here: it reads
  // this process's watcher state, which a child cannot see.
  if (!options?.report && shouldIndexOutOfProcess()) {
    return indexFolderInChild(folderPath, rootPath, repoName, options);
  }

  // Clear tsconfig path resolver cache so config edits between runs take effect.
  // The two-level cache (configCache + dirToConfigCache) is module-level and
  // would otherwise serve stale alias mappings if a user edited tsconfig.json
  // between successive index_folder calls within the same MCP server process.
  clearTsconfigCache();

  const config = loadConfig();
  const startTime = Date.now();

  const indexPath = getIndexPath(config.dataDir, rootPath);

  // A linked worktree being indexed for the FIRST time can be copied from its parent instead of
  // parsed. Measured: parent 14,891 files, worktree 14,405, eleven different — 0.08%. The copy is
  // milliseconds; the parse is minutes.
  //
  // First time only. An existing index carries incremental updates the parent never saw, and
  // overwriting it with the parent's content would silently discard them — worse than being slow.
  // `include_paths` also opts out: a scoped index is deliberately partial, and a seed would quietly
  // make it whole-repo.
  if (!options?.include_paths) {
    const alreadyIndexed = await getRepo(config.registryPath, repoName);
    if (!alreadyIndexed) {
      const { seedWorktreeIndexFromParent } = await import("./worktree-seed.js");
      const seed = await seedWorktreeIndexFromParent(rootPath, repoName, indexPath);
      if (seed.seeded) {
        const distance = seed.donor_distance !== undefined ? `, ${seed.donor_distance} commit(s) back` : "";
        const vectors = seed.embeddings === undefined
          ? ""
          : "vectors" in seed.embeddings
            ? `, ${seed.embeddings.vectors} vectors cloned`
            : `, no vectors (${seed.embeddings.skipped})`;
        console.error(
          `[codesift] Seeded ${repoName} from ${seed.parent_repo}${distance} in ${seed.elapsed_ms} ms ` +
          `(${seed.files} files, ${seed.symbols} symbols${vectors}) — bringing it to this tree's HEAD…`,
        );
        const { catchUpSeededWorktree } = await import("./worktree-seed.js");
        const caught = await catchUpSeededWorktree(
          rootPath,
          repoName,
          seed.seeded_at_commit ?? null,
          seed.files,
          seed.donor_root,
        );
        if (caught.caught_up) {
          const summary = await loadIndexSummary(indexPath);
          console.error(
            `[codesift] ${repoName}: caught up ${caught.updated} changed + ${caught.removed} removed ` +
            `file(s) — ${Date.now() - startTime} ms total instead of a full parse`,
          );
          return {
            repo: repoName,
            root: rootPath,
            file_count: summary?.file_count ?? seed.files ?? 0,
            symbol_count: summary?.symbol_count ?? seed.symbols ?? 0,
            duration_ms: Date.now() - startTime,
            reason: `seeded from ${seed.parent_repo}`,
            ...(seed.parent_repo !== undefined ? { seeded_from: seed.parent_repo } : {}),
            ...(seed.embeddings && "vectors" in seed.embeddings
              ? { seeded_vectors: seed.embeddings.vectors }
              : {}),
            ...(redirected ? { redirected_from: requestedPath } : {}),
            files_reparsed: caught.updated ?? 0,
            // Same reasoning as the walk path: a file that failed to index is absent, and absence
            // reads as "nothing to see here". Reported so a missing symbol has a cause.
            ...(caught.failed && caught.failed.length > 0
              ? { reparse_failures: caught.failed.length, reparse_failed_sample: caught.failed.slice(0, 10) }
              : {}),
          };
        }
        // The seed is on disk but cannot be trusted to be a near-match (unreachable commit, or too
        // many differences to be worth patching). Fall through to the full walk, which OVERWRITES
        // it — slow and correct beats fast and wrong.
        console.error(`[codesift] ${repoName}: seed not usable (${caught.reason}) — full index`);
      }
      // Not seedable — say why once, then fall through to the full walk below. This is the line
      // that tells a user why their worktree took minutes instead of milliseconds.
      if (seed.reason && seed.reason !== "not a linked worktree") {
        console.error(`[codesift] ${repoName}: full index (${seed.reason})`);
      }
    }
  }

  // Read .codesiftignore for user-defined exclude patterns
  let excludePatterns: string[] | undefined;
  try {
    const ignoreContent = await readFile(join(rootPath, ".codesiftignore"), "utf-8");
    excludePatterns = ignoreContent
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0);
    if (excludePatterns.length === 0) excludePatterns = undefined;
  } catch {
    // .codesiftignore not found — proceed without patterns
  }

  // Walk directory and collect parseable files. maxFiles caps unbounded walks
  // (huge monorepos, vendored data sets) before they OOM the process — see
  // DEFAULT_MAX_FILES rationale above.
  const maxFiles = options?.max_files ?? getDefaultMaxFiles();
  const files = await walkDirectory(rootPath, {
    includePaths: options?.include_paths,
    excludePatterns,
    maxFiles,
    fileFilter: (ext, name) => !!getLanguageForExtension(ext) || (name?.startsWith(".env") ?? false),
  });
  const hitFileLimit = files.length >= maxFiles;
  if (hitFileLimit) {
    // stderr only is how this stayed invisible: the caller got an ordinary
    // success result and no way to know the index was partial. It is reported
    // on the result too now — see `file_limit_hit`.
    console.error(
      `[codesift] index_folder: ${rootPath} hit max_files=${maxFiles}; ` +
      `partial index. Pass include_paths to scope the walk or raise max_files.`,
    );
  }

  // mtime-based incremental: skip files unchanged since last index
  const existing = await loadIndex(indexPath);
  const mtimeMap = new Map<string, number>();
  if (existing) {
    for (const f of existing.files) {
      if (f.mtime_ms) mtimeMap.set(f.path, f.mtime_ms);
    }
  }

  // Load and validate the persistent hash snapshot paired with the existing index.
  const oldSnapshot = existing
    ? await loadIndexSnapshot(indexPath, repoName, existing.updated_at)
    : null;

  const filesToParse: string[] = [];
  const keptSymbols: CodeSymbol[] = [];
  const keptEntries: FileEntry[] = [];

  // sha1 of every file in the NEW index, by relPath. Populated for reused files
  // here (from the old snapshot when present, else hashed-now for convergence)
  // and for parsed files after parseFiles resolves.
  const newSnapshotFiles: Record<string, string> = {};

  // CRITICAL-1: reused files whose sha1 must be (re)computed because the old
  // snapshot lacks it (legacy snapshot-less index, or stale snapshot discarded
  // above). Collected here and hashed AFTER the loop in PARSE_CONCURRENCY
  // batches instead of one serial await per file inside the loop — on a first
  // run after upgrade against a many-thousand-file repo the serial version cost
  // thousands of sequential awaits. Behavior is identical, wall-clock is
  // parallelized.
  //
  // mtimeMs: the mtime observed at decision time (the moment we confirmed
  // mtime === prevMtime and placed the file in the queue). We re-stat after
  // hashing to detect any concurrent modification that landed between the two
  // operations. If the mtime drifted, we omit the file from newSnapshotFiles
  // entirely — the missing sha causes the next cold run to re-parse, avoiding
  // a snapshot that pairs new-content sha against old (reused) symbols.
  const legacyHashQueue: Array<{ relPath: string; filePath: string; mtimeMs: number }> = [];

  // PERF: pre-build per-file lookups ONCE before the reuse loop. Both reuse
  // branches need (a) the existing index's symbols for a given relPath and (b)
  // its FileEntry. Doing `existing.symbols.filter(s => s.file === relPath)` /
  // `existing.files.find(f => f.path === relPath)` per file is O(files ×
  // symbols) and O(files²) respectively — quadratic, and on a many-thousand
  // file/symbol repo that dominated the reuse-heavy fast path. A single pass
  // builds Map lookups each branch hits in O(1). Built only when there's an
  // existing index to reuse from.
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  const fileEntryByPath = new Map<string, FileEntry>();
  if (existing) {
    for (const sym of existing.symbols) {
      const list = symbolsByFile.get(sym.file);
      if (list) list.push(sym);
      else symbolsByFile.set(sym.file, [sym]);
    }
    for (const fe of existing.files) {
      fileEntryByPath.set(fe.path, fe);
    }
  }

  if (mtimeMap.size > 0) {
    const { stat } = await import("node:fs/promises");
    for (const filePath of files) {
      const relPath = relative(rootPath, filePath);
      const prevMtime = mtimeMap.get(relPath);
      if (prevMtime !== undefined) {
        const fileEntry = fileEntryByPath.get(relPath);
        // Force re-parse if file is marked stale (callee signature changed)
        if (fileEntry?.stale) {
          filesToParse.push(filePath);
          continue;
        }
        try {
          const st = await stat(filePath);
          if (Math.round(st.mtimeMs) === prevMtime) {
            // Fast path: mtime unchanged → reuse symbols without hashing.
            const fileSymbols = symbolsByFile.get(relPath) ?? [];
            if (fileEntry) {
              keptSymbols.push(...fileSymbols);
              keptEntries.push(fileEntry);
              // Carry the sha1 forward: reuse from old snapshot if present,
              // else DEFER hashing so legacy (snapshot-less) indexes converge
              // to a complete snapshot after one run — without paying a serial
              // hash per file inside this loop.
              const carried = oldSnapshot?.files[relPath];
              if (carried !== undefined) {
                newSnapshotFiles[relPath] = carried;
              } else {
                legacyHashQueue.push({ relPath, filePath, mtimeMs: Math.round(st.mtimeMs) });
              }
              continue;
            }
          } else {
            // mtime changed — hash decides reuse vs re-parse. This catches
            // touch/checkout that bumped mtime without changing content.
            const snapSha = oldSnapshot?.files[relPath];
            if (snapSha !== undefined && fileEntry && !fileEntry.stale) {
              const currentSha = await sha1OfFile(filePath);
              if (currentSha !== null && currentSha === snapSha) {
                const fileSymbols = symbolsByFile.get(relPath) ?? [];
                keptSymbols.push(...fileSymbols);
                // FIX: the file's mtime changed but content is identical (touch /
                // checkout no-op rewrite). Reuse the symbols, but DON'T carry the
                // stale FileEntry verbatim — its mtime_ms still holds the OLD
                // mtime, so every future run would see mtime !== prevMtime and
                // re-hash this file forever, permanently degrading it off the
                // mtime fast path. Clone the entry with mtime_ms bumped to the
                // CURRENT stat's mtime so the next run takes the cheap fast path.
                keptEntries.push({ ...fileEntry, mtime_ms: Math.round(st.mtimeMs) });
                newSnapshotFiles[relPath] = currentSha;
                continue;
              }
            }
          }
        } catch { /* file may have been deleted — reparse */ }
      }
      filesToParse.push(filePath);
    }
  } else {
    filesToParse.push(...files);
  }

  // Drain the deferred legacy-hash queue (CRITICAL-1): files reused via the
  // mtime fast path that had no carried sha1 (legacy snapshot-less index, or a
  // stale snapshot discarded by the guard above). See drainLegacyHashQueue for
  // the TOCTOU guard details — entries whose mtime drifted between decision
  // time and hash time are omitted so the next run re-parses rather than
  // reusing symbols against a mismatched sha.
  if (legacyHashQueue.length > 0) {
    const drained = await drainLegacyHashQueue(legacyHashQueue);
    Object.assign(newSnapshotFiles, drained);
  }

  // Parse only changed/new files
  const { symbols: parsedSymbols, fileEntries: parsedEntries, shas: parsedShas, failed: parseFailed } = await parseFiles(filesToParse, rootPath, repoName);
  const symbols = [...keptSymbols, ...parsedSymbols];
  const fileEntries = [...keptEntries, ...parsedEntries];

  // Record sha1s for the files that were actually parsed (changed/new).
  // CRITICAL-1 (TOCTOU): these hashes come straight from parseOneFile — they
  // are the sha1 of the EXACT source string that produced the symbols, so the
  // snapshot can never pair old symbols with a newer file's sha. Only entries
  // that survived parseFiles (parseOneFile returned non-null) have a sha here,
  // keeping the snapshot in lockstep with fileEntries. The previous post-parse
  // double-read loop is gone — one fewer full read per parsed file.
  for (const entry of parsedEntries) {
    const sha = parsedShas[entry.path];
    if (sha !== undefined) newSnapshotFiles[entry.path] = sha;
  }

  // Dirty propagation: detect signature changes and mark caller files stale
  if (existing && filesToParse.length > 0 && filesToParse.length < files.length) {
    const staleFiles = propagateDirtySignatures(existing.symbols, symbols, fileEntries);
    if (staleFiles.size > 0) {
      console.error(`[codesift] Dirty propagation: ${staleFiles.size} caller files marked stale`);
    }
  }

  // Invalidate code index cache (BM25 is rebuilt below from the FINAL symbol
  // set — possibly merged with out-of-scope existing symbols, see merge block).
  codeIndexes.delete(repoName);

  const mergeResult = await validateAndMergeFolderWalk({
    existing,
    fileEntries,
    symbols,
    newSnapshotFiles,
    oldSnapshot,
    rootPath,
    repoName,
    startTime,
    maxFiles,
    hitFileLimit,
    includePaths: options?.include_paths,
  });
  if (!("mergedSymbols" in mergeResult)) return mergeResult;
  const { mergedSymbols, mergedEntries, mergedSnapshotFiles } = mergeResult;

  // Build and cache BM25 index from the FINAL (possibly merged) symbol set.
  // Built here (not before the guard) so a rejected_partial early-return leaves
  // the previous in-memory BM25 index intact rather than swapping in a partial.
  const bm25Started = Date.now();
  const bm25 = await buildBM25IndexYielding(mergedSymbols);
  const bm25BuildMs = Date.now() - bm25Started;
  rememberBM25Index(repoName, bm25);

  // Resolve workspaces (Task 7) — runs before persistence so collectImportEdges
  // and other downstream consumers see the populated `workspaces` field.
  // Gated behind CODESIFT_DISABLE_MONOREPO=1 kill switch (spec D-FB).
  let workspaces: import("../../types.js").Workspace[] | undefined;
  if (process.env.CODESIFT_DISABLE_MONOREPO !== "1") {
    try {
      const { resolveWorkspaces } = await import("../../storage/workspace-resolver.js");
      const resolved = await resolveWorkspaces(rootPath);
      if (resolved) workspaces = resolved.workspaces;
    } catch {
      // Resolver should never throw, but guard belt-and-braces — flat-repo
      // mode is the safe fallback.
    }
  }

  // Build and save code index from the FINAL (possibly merged) sets.
  const codeIndex: CodeIndex = {
    repo: repoName,
    root: rootPath,
    symbols: mergedSymbols,
    files: mergedEntries,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: mergedSymbols.length,
    file_count: mergedEntries.length,
    extractor_version: { ...EXTRACTOR_VERSIONS },
    ...(workspaces ? { workspaces } : {}),
  };
  // Source-complete only when this run parsed every file it is about to store. The mtime reuse
  // path above keeps symbols from the previous index for unchanged files, and those carry
  // whatever an older schema left behind — so a partial re-parse must not clear the lossy marker.
  await saveIndex(indexPath, codeIndex, { sourceComplete: filesToParse.length === files.length });

  // In an index child the BM25 index just built dies with the process, and the daemon's first
  // search would rebuild it — measured 10.04 s against 0.70 s to reload the sidecar on the largest
  // index here (registry.ts, BM25_PERSIST_MIN_BUILD_MS). Same threshold as that path: persist only
  // when the build cost something. Awaited, because the process exits right after it returns.
  if (options?.report && bm25BuildMs >= BM25_PERSIST_MIN_BUILD_MS) {
    try {
      const { saveBM25Index } = await import("../../search/bm25-store.js");
      await saveBM25Index(indexPath, bm25, codeIndex);
    } catch {
      // A cache that failed to write is rebuilt on first use — slower, never wrong.
    }
  }

  // Persist the hash snapshot AFTER the index lands (mirrors registerRepo
  // ordering) and only on the success path — the rejected_partial branch
  // returned earlier, leaving the previous snapshot intact. Non-fatal: the
  // snapshot is a reuse-optimization cache; a write failure just costs a full
  // re-parse next run, so we warn and continue.
  try {
    const newSnapshot: FileHashSnapshot = {
      version: HASH_SNAPSHOT_VERSION,
      repo: repoName,
      // CRITICAL-2 (created_at race): use the EXACT timestamp serialized into
      // the index, not a fresh Date.now(). A watcher's saveIncremental that
      // lands between saveIndex and this write would otherwise leave the
      // snapshot OLDER than created_at, blinding the staleness guard above. By
      // anchoring to codeIndex.updated_at, snapshot.created_at === the index's
      // updated_at on a fresh write, so any later incremental strictly advances
      // index.updated_at past it and the guard fires correctly.
      created_at: codeIndex.updated_at,
      files: mergedSnapshotFiles,
    };
    await saveIndexSnapshot(indexPath, newSnapshot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[codesift] hash-snapshot save failed for ${repoName} (non-fatal): ${msg}`);
  }

  // Embed symbols and chunks in the background (non-fatal, must not block the
  // MCP response — large repos take minutes). Serialised per repo so repeated
  // watcher events queue instead of piling up concurrently; see embeddingRuns.
  //
  // The CLI opts out via CODESIFT_EMBED_OUT_OF_PROCESS and runs the same work in
  // a child process instead, so that a short-lived command never loads
  // onnxruntime — see src/cli/embed-child.ts for why that matters. The
  // long-lived MCP server keeps embedding in-process: it does not exit, so the
  // teardown conflict cannot arise there.
  if (process.env["CODESIFT_EMBED_OUT_OF_PROCESS"] !== "1") {
    scheduleEmbedding(repoName, async () => {
      await embedSymbols(mergedSymbols, indexPath, repoName, config);
      await embedChunks(mergedEntries, rootPath, repoName, indexPath, config, mergedSymbols);
    });
  }

  // Register in the global registry. If a stale entry exists with the same
  // root but a different name (e.g. `local/workspace` from before the git
  // origin auto-detect landed), drop it so `list_repos` doesn't show ghosts.
  const existingRepos = await listRegistryRepos(config.registryPath);
  for (const stale of existingRepos) {
    if (stale.root === rootPath && stale.name !== repoName) {
      await removeRepo(config.registryPath, stale.name);
      console.error(`[codesift] Migrated registry: ${stale.name} -> ${repoName} (same root)`);
    }
  }

  const meta: RepoMeta = {
    name: repoName,
    root: rootPath,
    index_path: indexPath,
    symbol_count: mergedSymbols.length,
    file_count: mergedEntries.length,
    updated_at: Date.now(),
  };
  await registerRepo(config.registryPath, meta);

  // Capture git HEAD for auto-refresh tracking
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootPath, encoding: "utf-8", timeout: 5000,
    }).trim();
    await updateRepoMeta(config.registryPath, repoName, { last_git_commit: head });
  } catch {
    // Not a git repo — skip
  }

  // Start file watcher for incremental updates (unless disabled)
  if (options?.watch !== false) {
    await setupWatcher(rootPath, repoName, indexPath);
  }

  // Auto-enable framework-specific tool bundles (NestJS, etc.)
  // Lazy import to avoid circular dep: index-tools → register-tools → tool handlers → index-tools
  try {
    const { detectFrameworks } = await import("../../utils/framework-detect.js");
    const tempIndex = { root: rootPath, files: mergedEntries, symbols: mergedSymbols } as CodeIndex;
    const frameworks = detectFrameworks(tempIndex);
    if (options?.report) {
      // The tool surface belongs to the daemon; enabling it in a child would enable nothing. The
      // daemon applies the list through enableReportedFrameworks.
      options.report.frameworks = [...frameworks];
    } else {
      await enableReportedFrameworks(frameworks, repoName);
    }
  } catch {
    // Non-fatal — framework auto-enable is a convenience feature
  }

  if (options?.report) {
    options.report.completed = true;
    options.report.index_path = indexPath;
  }

  // Record completion timestamp so subsequent re-runs can short-circuit when
  // the watcher is keeping the index fresh.
  lastFullIndexAt.set(rootPath, Date.now());

  return {
    repo: repoName,
    root: rootPath,
    // Files the walk could not parse. A file that fails to parse is simply ABSENT from the index,
    // and absence is indistinguishable from "this file has no symbols" — so without this the
    // caller is told the index is complete when it is not. The sample is capped because the
    // number matters more than the list once it is large.
    ...(parseFailed.length > 0
      ? {
          parse_failures: parseFailed.length,
          parse_failed_sample: parseFailed.slice(0, 10),
        }
      : {}),
    // Present on every path that indexes, not only the seeded one — the caller asked for a
    // different directory than the one that got indexed, and that must never be silent.
    ...(redirected ? { redirected_from: requestedPath } : {}),
    file_count: mergedEntries.length,
    symbol_count: mergedSymbols.length,
    duration_ms: Date.now() - startTime,
    ...(hitFileLimit
      ? {
          file_limit_hit: true,
          hint:
            `Walk stopped at max_files=${maxFiles}, so this index covers only part of the repo. `
            + "Check for a large vendored or generated tree, add it to .codesiftignore, "
            + "or raise the cap with CODESIFT_MAX_FILES.",
        }
      : {}),
  };
}
