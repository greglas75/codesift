import type { ToolRecommendation } from "../../search/tool-ranker.js";
import type { SymbolKind } from "../../types.js";

export interface ParsedQuery {
  original: string;
  normalized: string;
  truncated: boolean;
  intents: string[];
  file_refs: string[];
  symbol_refs: string[];
  is_vague: boolean;
}

export interface SymbolRecommendation {
  name: string;
  file: string;
  line: number;
  kind: SymbolKind;
  score: number;
}

export interface FileRecommendation {
  path: string;
  score: number;
  reason: "explicit file reference" | "referenced in query";
}

export interface GapAnalysis {
  action: "STOP_AND_REPORT_GAP";
  prior_query: string;
  prior_result_count: number;
  suggestion: string;
}

export interface PlanTurnMetadata {
  intents_detected: number;
  bm25_candidates: number;
  embedding_available: boolean;
  session_queries_seen: number;
  duration_ms: number;
  truncated?: boolean;
  vague_query?: boolean;
  stale_index?: boolean;
  low_discrimination?: boolean;
  framework_mismatch?: boolean;
  cold_start?: boolean;
  unindexed?: boolean;
}

export interface PlanTurnResult {
  query: string;
  truncated: boolean;
  confidence: number;
  tools: ToolRecommendation[];
  symbols: SymbolRecommendation[];
  files: FileRecommendation[];
  reveal_required: string[];
  already_used: string[];
  gap_analysis?: GapAnalysis;
  framework_context?: string;
  metadata: PlanTurnMetadata;
}

export interface PlanTurnOptions {
  max_results?: number;
  skip_session?: boolean;
}
