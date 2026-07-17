import type { CodeSymbol } from "../../types.js";

export type ContextLevel = "L0" | "L1" | "L2" | "L3";

export interface SymbolCompact {
  id: string;
  name: string;
  kind: string;
  file: string;
  start_line: number;
  signature?: string;
  docstring?: string;
}

export interface FileSummary {
  path: string;
  language: string;
  exports: string[];
  symbol_count: number;
}

export interface DirectoryOverview {
  path: string;
  file_count: number;
  symbol_count: number;
  top_files: string[];
}

export interface AssembleContextResult {
  symbols?: CodeSymbol[];
  compact_symbols?: SymbolCompact[];
  file_summaries?: FileSummary[];
  directory_overview?: DirectoryOverview[];
  level: ContextLevel;
  total_tokens: number;
  truncated: boolean;
  result_count: number;
}
