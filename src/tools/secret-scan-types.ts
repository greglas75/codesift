export type SecretSeverity = "critical" | "high" | "medium" | "low";

export interface SecretContext {
  type: "test" | "doc" | "config" | "production";
  symbol_name?: string;
  symbol_kind?: string;
}

export interface SecretFinding {
  rule: string;
  label: string;
  masked_secret: string;
  confidence: "high" | "medium" | "low";
  severity: SecretSeverity;
  file: string;
  line: number;
  context: SecretContext;
}

export interface SecretCacheEntry {
  mtime_ms: number;
  findings: SecretFinding[];
}
