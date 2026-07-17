export interface PythonAuditGate {
  name: string;
  status: "ok" | "error" | "timeout" | "skipped";
  findings_count: number;
  duration_ms: number;
  error?: string;
}

export interface PythonAuditResult {
  repo: string;
  duration_ms: number;
  checks_run: string[];
  gates: PythonAuditGate[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    health_score: number;
    top_risks: string[];
  };
  findings: {
    circular_imports?: number;
    django_critical?: number;
    django_high?: number;
    anti_patterns?: number;
    orphan_tasks?: number;
    unpinned_deps?: number;
    dead_code?: number;
    fixture_count?: number;
  };
}

export interface PythonAuditOptions {
  file_pattern?: string;
  checks?: string[];
}

export interface CheckRun<T = unknown> {
  name: string;
  result: T | "TIMEOUT" | "ERROR";
  ms: number;
  error?: string;
}
