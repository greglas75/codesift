import type { CodeIndex } from "../../types.js";
import { getCurrentGitCommit } from "../../utils/git-head.js";

const STALE_INDEX_TIME_FALLBACK_MS = 24 * 60 * 60 * 1000;
const GIT_HEAD_TIMEOUT_MS = 1500;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function safeReadGitHead(repoRoot: string): string | null {
  const head = getCurrentGitCommit(repoRoot, GIT_HEAD_TIMEOUT_MS);
  return head !== null && FULL_GIT_SHA_RE.test(head) ? head : null;
}

/**
 * How much the index can be trusted, and on what evidence.
 *
 * A boolean cannot carry this. "git HEAD moved, so the index is definitely behind" and "there is
 * no git here, so I am guessing from the index being over a day old" both used to come out as
 * `true`, and "HEAD matches" and "I could not check but it is recent" both came out as `false`.
 * The second pair is the dangerous one: an agent reading `staleIndex: false` cannot tell a
 * verified-current index from one nobody could verify, so an empty result reads as proof of
 * absence either way.
 *
 * `basis` is the part that matters — it says what the verdict rests on, so a caller can decide
 * whether to state a conclusion or to hedge it.
 */
export type IndexFreshness =
  | { status: "current"; basis: "git_head_match" }
  | { status: "stale"; basis: "git_head_moved"; indexedCommit: string; headCommit: string }
  | { status: "unknown"; basis: "no_git_head" | "no_indexed_commit"; ageMs: number; likelyStale: boolean };

export function assessIndexFreshness(
  index: CodeIndex,
  lastGitCommit: string | undefined,
): IndexFreshness {
  const headSha = safeReadGitHead(index.root);
  if (headSha !== null && lastGitCommit !== undefined) {
    return headSha === lastGitCommit
      ? { status: "current", basis: "git_head_match" }
      : {
          status: "stale",
          basis: "git_head_moved",
          indexedCommit: lastGitCommit,
          headCommit: headSha,
        };
  }
  // No commit to compare against. Age is a heuristic, not evidence — say so rather than
  // reporting a guess in the same shape as a measurement.
  const ageMs = Date.now() - (index.updated_at ?? index.created_at ?? 0);
  return {
    status: "unknown",
    basis: headSha === null ? "no_git_head" : "no_indexed_commit",
    ageMs,
    likelyStale: ageMs > STALE_INDEX_TIME_FALLBACK_MS,
  };
}

/**
 * Boolean view, kept for callers that genuinely only need "should I suggest a reindex".
 * Preserves the original semantics exactly: unknown-and-old counts as stale.
 */
export function isStaleIndex(
  index: CodeIndex,
  lastGitCommit: string | undefined,
): boolean {
  const freshness = assessIndexFreshness(index, lastGitCommit);
  if (freshness.status === "stale") return true;
  if (freshness.status === "unknown") return freshness.likelyStale;
  return false;
}
