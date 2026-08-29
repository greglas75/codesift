import { readFile, stat } from "node:fs/promises";
import { runGit } from "../git-exec.js";
import { join, resolve, relative, basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { clearTsconfigCache } from "../../utils/tsconfig-paths.js";
import {
  getRepo,
  listRepos as listRegistryRepos,
  updateRepoMeta,
} from "../../storage/registry.js";
import { getFileEntry, saveIncremental } from "../../storage/index-store.js";
import { loadConfig } from "../../config.js";
import { currentCwd, hasRequestContext } from "../../server-helpers/request-context.js";
import { scanFileForSecrets } from "../secret-scan-shared.js";
import { parseOneFile } from "./parse.js";
import { indexFolder } from "./folder-indexer.js";
import { bm25Indexes, codeIndexes, invalidateEmbeddingCaches } from "./state.js";

/**
 * In-process record of the last indexed state per absolute file path.
 *
 * Telemetry (30d, 2026-06): 750 consecutive duplicate index_file calls at
 * avg 3.7s each (~47 min of agent wall-clock). Two causes: (1) duplicate
 * hook registrations firing index_file twice per edit, and (2) a race where
 * call N+1's on-disk mtime pre-check read the index before call N's
 * serialized saveIncremental landed, forcing a full re-parse + full-index
 * save. This map short-circuits both in-process in ~1ms (mtime first, then
 * content hash for touch/no-op rewrites) without loading the on-disk index.
 */
const lastIndexedState = new Map<string, { mtimeMs: number; contentHash: string; symbolCount: number }>();

/** Test hook — clear the in-process last-indexed state. */
export function clearLastIndexedStateForTesting(): void {
  lastIndexedState.clear();
}

/**
 * Re-index a single file instantly. Finds the repo by matching the file
 * path against indexed repo roots. Updates symbols, BM25 index, and
 * invalidates embedding cache — no full repo walk needed.
 */
export async function indexFile(filePath: string): Promise<{
  repo: string;
  file: string;
  symbol_count: number;
  duration_ms: number;
  skipped?: boolean;
  secrets_warning?: string;
  /** The file no longer exists and its symbols were pruned from the index. */
  removed?: boolean;
}> {
  // A relative path is resolved against THIS REQUEST's directory, not the process's. Under stdio the
  // two are the same; under the shared daemon the process runs from `/` (launchd), so `resolve()`
  // alone turned `apps/api/x.ts` into `/apps/api/x.ts` and every such call failed. Measured
  // 2026-08-30: 20 of 36 calls in one 15-minute window, all of them the PostToolUse hook reporting
  // an edit, all lost.
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(currentCwd(), filePath);
  const config = loadConfig();
  const repos = await listRegistryRepos(config.registryPath);

  // Find the most specific repo root that contains this file
  const matchingRepo = repos
    .filter((r) => absPath.startsWith(r.root + "/") || absPath === r.root)
    .sort((a, b) => b.root.length - a.root.length)[0];

  if (!matchingRepo) {
    // Name the real cause when there was one. `No indexed repo contains "/apps/api/x.ts"` is true
    // and useless: the leading slash IS the diagnosis, and nobody reads it that way.
    //
    // Deliberately NOT guessed at: this same relative path exists under the main checkout and
    // fifteen worktrees of it, so picking one would index the wrong tree — the exact confusion the
    // `?cwd=` mechanism exists to prevent.
    if (!isAbsolute(filePath) && !hasRequestContext()) {
      throw new Error(
        `Cannot resolve relative path "${filePath}": this connection carries no working directory, ` +
          `so it resolved to "${absPath}". Add ?cwd=<abs path> to the MCP server URL ` +
          `(\`codesift setup <client> --http\` writes it), or pass an absolute path.`,
      );
    }
    throw new Error(`No indexed repo contains "${absPath}". Run index_folder first.`);
  }

  const startTime = Date.now();
  const relPath = relative(matchingRepo.root, absPath);

  // If the changed file is a TS/JS config that drives path resolution, drop
  // caches so incremental indexing picks up new `paths` / `extends`.
  {
    const cfg = basename(absPath).toLowerCase();
    if (
      (cfg.startsWith("tsconfig") || cfg.startsWith("jsconfig")) &&
      cfg.endsWith(".json")
    ) {
      clearTsconfigCache();
    }
  }

  // A file that is GONE is a normal outcome here, not a fault: agents are told to call index_file
  // after editing, and deleting or renaming a file is editing. Unguarded, `stat` escaped as a raw
  // `ENOENT: no such file or directory, stat '<abs>'` — a Node-level string that names neither the
  // repo nor what to do, and one of the three indistinguishable ~3ms failures behind index_file's
  // 8.8% error rate.
  //
  // Worse, the index kept the deleted file's symbols. `handleFileDelete` lives in the WATCHER only,
  // and the CLI hook (`codesift postindex-file`) is a fresh process with no watcher — so the path
  // agents are actually told to use had no deletion branch at all, and stale symbols outlived the
  // files they came from.
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(absPath);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    const { removeFileFromIndex } = await import("../../storage/index-store.js");
    await removeFileFromIndex(matchingRepo.index_path, relPath);
    lastIndexedState.delete(absPath);
    bm25Indexes.delete(matchingRepo.name);
    codeIndexes.delete(matchingRepo.name);
    return {
      repo: matchingRepo.name,
      file: relPath,
      symbol_count: 0,
      duration_ms: Date.now() - startTime,
      removed: true,
    };
  }
  const mem = lastIndexedState.get(absPath);
  if (mem && Math.round(st.mtimeMs) === mem.mtimeMs) {
    return {
      repo: matchingRepo.name,
      file: relPath,
      symbol_count: mem.symbolCount,
      duration_ms: Date.now() - startTime,
      skipped: true,
    };
  }
  const content = await readFile(absPath, "utf-8").catch(() => null);
  const contentHash = content !== null ? createHash("sha1").update(content).digest("hex") : null;
  if (mem && contentHash !== null && contentHash === mem.contentHash) {
    // Touched / rewritten with identical content — refresh mtime, skip work.
    mem.mtimeMs = Math.round(st.mtimeMs);
    return {
      repo: matchingRepo.name,
      file: relPath,
      symbol_count: mem.symbolCount,
      duration_ms: Date.now() - startTime,
      skipped: true,
    };
  }

  // On-disk mtime check — first touch of this file in this process (CLI
  // hook invocations, fresh server). Skips files unchanged since the last
  // full index, and seeds the in-process state for subsequent calls.
  if (!mem) {
    // One row, not the whole index: this check runs on the first touch of every file, and
    // the CLI hook is a fresh process per edit, so loading the full index here was the
    // single most-repeated whole-blob parse in the system (ADR-003).
    const prevEntry = await getFileEntry(matchingRepo.index_path, relPath);
    if (prevEntry?.mtime_ms && Math.round(st.mtimeMs) === prevEntry.mtime_ms) {
      if (contentHash !== null) {
        lastIndexedState.set(absPath, {
          mtimeMs: Math.round(st.mtimeMs),
          contentHash,
          symbolCount: prevEntry.symbol_count,
        });
      }
      return {
        repo: matchingRepo.name,
        file: relPath,
        symbol_count: prevEntry.symbol_count,
        duration_ms: Date.now() - startTime,
        skipped: true,
      };
    }
  }

  const result = await parseOneFile(absPath, matchingRepo.root, matchingRepo.name);
  if (!result) {
    throw new Error(`Failed to parse "${relPath}"`);
  }

  await saveIncremental(matchingRepo.index_path, relPath, result.symbols, result.entry);

  if (contentHash !== null) {
    lastIndexedState.set(absPath, {
      mtimeMs: Math.round(st.mtimeMs),
      contentHash,
      symbolCount: result.symbols.length,
    });
  }

  let secretFindingsCount = 0;
  if (config.secretScanEnabled) {
    try {
      secretFindingsCount = (
        await scanFileForSecrets(absPath, relPath, matchingRepo.name, result.symbols)
      ).length;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Secret scan failed for ${relPath}: ${message}`);
    }
  }

  // Invalidate caches — lazy rebuild on next query via getBM25Index()
  bm25Indexes.delete(matchingRepo.name);
  codeIndexes.delete(matchingRepo.name);
  invalidateEmbeddingCaches(matchingRepo.name);

  let secretsWarning: string | undefined;
  if (secretFindingsCount > 0) {
    secretsWarning = `\u26A0 ${secretFindingsCount} potential secret(s) detected`;
  }

  return {
    repo: matchingRepo.name,
    file: relPath,
    symbol_count: result.symbols.length,
    duration_ms: Date.now() - startTime,
    ...(secretsWarning ? { secrets_warning: secretsWarning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Git-based auto-refresh — transparent freshness check before index access
// ---------------------------------------------------------------------------

const freshnessChecked = new Map<string, number>();
const FRESHNESS_INTERVAL_MS = 60_000;
const MAX_DIFF_FILES = 50;

/**
 * Ensure the index for a repo is fresh relative to git HEAD.
 * Throttled to once per minute per repo. Reindexes changed files if HEAD moved.
 * No-op for non-git repos.
 */
export async function ensureIndexFresh(repoName: string): Promise<{
  status: "fresh" | "refreshed" | "skipped";
  files_updated?: number;
}> {
  const lastCheck = freshnessChecked.get(repoName);
  if (lastCheck && Date.now() - lastCheck < FRESHNESS_INTERVAL_MS) {
    return { status: "fresh" };
  }

  const config = loadConfig();
  const meta = await getRepo(config.registryPath, repoName);
  if (!meta) return { status: "skipped" };

  // Asynchronous, and this is the call site where it matters most: `ensureIndexFresh` runs from
  // `getCodeIndex`, i.e. on the path of EVERY repo-scoped tool. As `execFileSync` it stopped the
  // whole shared daemon for as long as git took — up to 5 s here and 10 s for the diff below —
  // once per repo per freshness interval, for every client on the machine.
  let currentCommit: string;
  try {
    currentCommit = (await runGit(["rev-parse", "HEAD"], { cwd: meta.root, timeout: 5000 })).trim();
  } catch {
    freshnessChecked.set(repoName, Date.now());
    return { status: "skipped" };
  }

  if (meta.last_git_commit === currentCommit) {
    freshnessChecked.set(repoName, Date.now());
    return { status: "fresh" };
  }

  // HEAD moved — find changed files
  let changedFiles: string[] = [];
  if (meta.last_git_commit) {
    try {
      const diff = await runGit([
        "diff", "--name-only", "--diff-filter=ACMR",
        `${meta.last_git_commit}..${currentCommit}`,
      ], { cwd: meta.root, timeout: 10_000 });
      changedFiles = diff.trim().split("\n").filter(Boolean);
    } catch {
      // Stored commit gone (rebase/squash) — will do full incremental
      changedFiles = [];
    }
  }

  if (changedFiles.length > 0 && changedFiles.length <= MAX_DIFF_FILES) {
    for (const file of changedFiles) {
      try {
        await indexFile(join(meta.root, file));
      } catch {
        // File deleted or unparseable — skip
      }
    }
  } else if (changedFiles.length > MAX_DIFF_FILES || !meta.last_git_commit) {
    await indexFolder(meta.root, { incremental: true, watch: false });
  }

  await updateRepoMeta(config.registryPath, repoName, {
    last_git_commit: currentCommit,
    updated_at: Date.now(),
  });

  bm25Indexes.delete(repoName);
  codeIndexes.delete(repoName);
  invalidateEmbeddingCaches(repoName);

  freshnessChecked.set(repoName, Date.now());
  return { status: "refreshed", files_updated: changedFiles.length };
}

/** Reset freshness throttle cache. Exported for testing. */
export function resetFreshnessCache(): void {
  freshnessChecked.clear();
}
