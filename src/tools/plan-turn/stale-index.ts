import type { CodeIndex } from "../../types.js";
import { getCurrentGitCommit } from "../../utils/git-head.js";

const STALE_INDEX_TIME_FALLBACK_MS = 24 * 60 * 60 * 1000;
const GIT_HEAD_TIMEOUT_MS = 1500;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function safeReadGitHead(repoRoot: string): string | null {
  const head = getCurrentGitCommit(repoRoot, GIT_HEAD_TIMEOUT_MS);
  return head !== null && FULL_GIT_SHA_RE.test(head) ? head : null;
}

export function isStaleIndex(
  index: CodeIndex,
  lastGitCommit: string | undefined,
): boolean {
  const headSha = safeReadGitHead(index.root);
  if (headSha !== null && lastGitCommit !== undefined) {
    return headSha !== lastGitCommit;
  }
  const indexAgeMs = Date.now() - (index.updated_at ?? index.created_at ?? 0);
  return indexAgeMs > STALE_INDEX_TIME_FALLBACK_MS;
}
