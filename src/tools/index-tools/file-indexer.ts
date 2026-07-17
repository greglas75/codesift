import { readFile, stat } from "node:fs/promises";
import { join, resolve, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { clearTsconfigCache } from "../../utils/tsconfig-paths.js";
import {
  getRepo,
  listRepos as listRegistryRepos,
  updateRepoMeta,
} from "../../storage/registry.js";
import { loadIndex, saveIncremental } from "../../storage/index-store.js";
import { loadConfig } from "../../config.js";
import { scanFileForSecrets } from "../secret-scan-shared.js";
import { parseOneFile } from "./parse.js";
import { indexFolder } from "./folder-indexer.js";
import { bm25Indexes, codeIndexes, embeddingCaches } from "./state.js";

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
}> {
  const absPath = resolve(filePath);
  const config = loadConfig();
  const repos = await listRegistryRepos(config.registryPath);

  // Find the most specific repo root that contains this file
  const matchingRepo = repos
    .filter((r) => absPath.startsWith(r.root + "/") || absPath === r.root)
    .sort((a, b) => b.root.length - a.root.length)[0];

  if (!matchingRepo) {
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

  // In-process short-circuit: mtime, then content hash. Both avoid loading
  // the on-disk index entirely (the expensive part on large repos).
  const st = await stat(absPath);
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
    const existing = await loadIndex(matchingRepo.index_path);
    if (existing) {
      const prevEntry = existing.files.find((f) => f.path === relPath);
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
  embeddingCaches.delete(matchingRepo.name);

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

  let currentCommit: string;
  try {
    currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: meta.root, encoding: "utf-8", timeout: 5000,
    }).trim();
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
      const diff = execFileSync("git", [
        "diff", "--name-only", "--diff-filter=ACMR",
        `${meta.last_git_commit}..${currentCommit}`,
      ], {
        cwd: meta.root, encoding: "utf-8", timeout: 10_000,
      });
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
  embeddingCaches.delete(repoName);

  freshnessChecked.set(repoName, Date.now());
  return { status: "refreshed", files_updated: changedFiles.length };
}

/** Reset freshness throttle cache. Exported for testing. */
export function resetFreshnessCache(): void {
  freshnessChecked.clear();
}
