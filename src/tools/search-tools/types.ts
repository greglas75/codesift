import type { SymbolKind } from "../../types.js";

export type DetailLevel = "compact" | "standard" | "full";

export interface SearchSymbolsOptions {
  kind?: SymbolKind | undefined;
  file_pattern?: string | undefined;
  decorator?: string | undefined;
  include_source?: boolean | undefined;
  top_k?: number | undefined;
  source_chars?: number | undefined;
  detail_level?: DetailLevel | undefined;
  token_budget?: number | undefined;
  rerank?: boolean | undefined;
}

export interface SearchTextOptions {
  regex?: boolean | undefined;
  file_pattern?: string | undefined;
  context_lines?: number | undefined;
  max_results?: number | undefined;
  group_by_file?: boolean | undefined;
  auto_group?: boolean | undefined;
  compact?: boolean | undefined;
  ranked?: boolean | undefined;
}

export interface ZeroHitFallbackResult {
  suggestions?: string[];
  semantic_results?: string;
  /**
   * Whether the semantic rescue actually ran.
   *
   * Without this, "searched by meaning and found nothing" and "never searched by meaning" reach
   * the agent as the same empty result — and the second one is not evidence of absence.
   * `repo_not_embedded` is the common case (no embedding provider configured, or lite mode on a
   * <24 GB machine), and it is silent today.
   */
  semantic_coverage?: {
    status: "searched" | "repo_not_embedded" | "timed_out" | "unknown";
    detail?: string;
  };
  /**
   * Whether the index the search ran against reflects the working tree. An empty result over an
   * index that predates the code is not a statement about the code.
   */
  index_freshness?: {
    status: "current" | "stale" | "unknown";
    detail?: string;
  };
}
