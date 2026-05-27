// Shared helper: read the current git HEAD SHA for a directory. Used by the
// SessionStart hook (staleness hint) and the wiki generator (manifest tracking).
// Best-effort: returns null on any failure (not a repo, git missing, timeout, …)
// so callers can degrade gracefully without try/catch noise.

import { execFileSync } from "node:child_process";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Short timeout — the SessionStart hook calls this on its hot path, and the
// hint is non-critical. If git stalls (e.g. network filesystem) we'd rather
// skip the hint than block session startup.
const DEFAULT_TIMEOUT_MS = 500;

export function getCurrentGitCommit(dir: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return SHA_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}
