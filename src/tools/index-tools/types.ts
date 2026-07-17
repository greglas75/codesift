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
  reason?: string;
  last_indexed?: string;
  hint?: string;
}
