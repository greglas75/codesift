import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * What git ignores under a repository root, so the walker, `index_file` and the watcher skip it.
 *
 * The walker knew only its own directory list (`IGNORE_DIRS`), never `.gitignore`. Measured
 * 2026-10-11 on rdesigner: **1,147,279 of 1,429,034 symbols (80%)** came from `zuvo/` — gitignored
 * recovery and context copies of the source tree. Every index of that repo (one per worktree) carried
 * them, and so did its BM25 index, its call graph (230M edges with tests, 3.1 GB), and every tool that
 * hit the 90 s timeout on it.
 *
 * `git ls-files --others --ignored --exclude-standard --directory` answers in ~0.15 s there (3,093
 * entries, whole ignored directories collapsed to one `dir/` line). Tracked files are never listed,
 * so a committed file that also matches a pattern stays indexed — git's own rule.
 * `CODESIFT_RESPECT_GITIGNORE=0` turns it off; outside a git checkout nothing is ignored.
 */
export interface GitIgnored {
  /** Whether `relPath` (relative to the root, `/`-separated) is ignored, itself or by a directory. */
  isIgnored(relPath: string): boolean;
  /** The collapsed entries, relative to the root: directories end with `/`. */
  readonly entries: readonly string[];
}

const LIST_TIMEOUT_MS = 15_000;
/** `index_file` and the watcher ask per event; one listing serves a burst of edits. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<GitIgnored | null> }>();

function respectsGitignore(): boolean {
  return process.env["CODESIFT_RESPECT_GITIGNORE"] !== "0";
}

/** Exported for tests: the predicate over a parsed listing. */
export function gitIgnoredFrom(entries: readonly string[]): GitIgnored {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const e of entries) {
    if (!e) continue;
    if (e.endsWith("/")) dirs.add(e);
    else files.add(e);
  }
  return {
    entries,
    isIgnored(relPath: string): boolean {
      const path = relPath.replaceAll("\\", "/");
      if (files.has(path)) return true;
      if (dirs.size === 0) return false;
      // Every ancestor directory, shallowest first: `a/`, `a/b/`, …
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        if (dirs.has(path.slice(0, i + 1))) return true;
      }
      return dirs.has(`${path}/`);
    },
  };
}

async function listIgnored(root: string): Promise<GitIgnored | null> {
  try {
    const { stdout } = await promisify(execFile)(
      "git",
      ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
      { timeout: LIST_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: "utf-8" },
    );
    return gitIgnoredFrom(stdout.split("\0"));
  } catch {
    // Not a git checkout, git missing, or a timeout: index what the walker's own rules allow.
    return null;
  }
}

/** The ignored set for `root`, or null when gitignore does not apply (off, or not a git checkout). */
export function loadGitIgnored(root: string, opts?: { fresh?: boolean }): Promise<GitIgnored | null> {
  if (!respectsGitignore()) return Promise.resolve(null);
  const hit = cache.get(root);
  if (hit && !opts?.fresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = listIgnored(root);
  cache.set(root, { at: Date.now(), value });
  return value;
}

export function resetGitIgnoredCacheForTesting(): void {
  cache.clear();
}
