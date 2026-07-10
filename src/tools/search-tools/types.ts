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
}
