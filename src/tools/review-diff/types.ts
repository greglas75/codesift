export interface ReviewDiffOptions {
  repo: string;
  since?: string;
  /** End ref — defaults to "HEAD". Use "WORKING" for uncommitted changes. */
  until?: string;
  /** Comma-separated check names to run (defaults to all) */
  checks?: string;
  /** Token budget for responses (default 8000) */
  token_budget?: number;
  /** Glob patterns of files to exclude from review */
  exclude_patterns?: string[];
  /** Maximum files to review before capping (default 50) */
  max_files?: number;
  /** Per-check timeout in milliseconds (default 30000) */
  check_timeout_ms?: number;
}

export interface ReviewFinding {
  /** Which check produced this finding */
  check: string;
  severity: "error" | "warn" | "info";
  message: string;
  file?: string;
  line?: number;
  symbol?: string;
}

export interface CheckResult {
  check: string;
  status: "pass" | "warn" | "fail" | "error" | "timeout";
  findings: ReviewFinding[];
  duration_ms: number;
  /** Human-readable summary line (optional) */
  summary?: string;
}

export interface DiffStats {
  files_changed: number;
  files_reviewed: number;
}

export interface ReviewMetadata {
  files_capped?: boolean;
  index_warning?: string;
}

export interface ReviewDiffResult {
  repo: string;
  since: string;
  checks: CheckResult[];
  findings: ReviewFinding[];
  /** 0-100 quality score */
  score: number;
  verdict: "pass" | "warn" | "fail";
  duration_ms: number;
  diff_stats: DiffStats;
  metadata: ReviewMetadata;
  /** Structured error (present instead of throwing) */
  error?: string;
}
