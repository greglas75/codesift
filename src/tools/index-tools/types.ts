export interface IndexFolderResult {
  repo: string;
  root: string;
  file_count: number;
  symbol_count: number;
  duration_ms: number;
  /**
   * Set when the call did not persist a fresh index:
   * - "skipped" — short-circuited because a watcher is keeping the index live.
   * - "rejected_partial" — new walk found <50% of the previous file count and
   *   the previous index still matches what's on disk, so the new (likely
   *   truncated) result was discarded. file_count/symbol_count echo the KEPT
   *   old index. Follow `hint` to force a rebuild if the shrink is expected.
   */
  status?: "skipped" | "rejected_partial";
  /**
   * True when the walk stopped at `max_files`, so the index covers only part of
   * the repo. Previously this went to stderr alone — the caller saw an ordinary
   * success and had no way to tell a complete index from a truncated one, which
   * is how two repos ran for months with their own source evicted by `vendor/`.
   */
  file_limit_hit?: boolean;
  reason?: string;
  last_indexed?: string;
  hint?: string;
  /**
   * Set when this index was COPIED from a parent checkout rather than parsed, naming the parent it
   * came from. A linked worktree differs from its parent by a handful of files (measured: 11 of
   * 14,405), so parsing the tree to discover that is the entire cost of indexing paid for almost
   * nothing. Its presence is also the honest answer to "why was this so fast".
   */
  seeded_from?: string;
  /** Files re-parsed after a seed to bring it from the parent's commit to this tree's HEAD. */
  files_reparsed?: number;
}
