export type Severity = "low" | "moderate" | "high" | "critical";

export interface Vulnerability {
  package: string;
  severity: Severity;
  via: string[];
  fix_available: boolean;
  advisory_url?: string;
}

export interface LicenseInfo {
  package: string;
  license: string;
  is_problematic: boolean;
}

export interface OutdatedPackage {
  package: string;
  current: string;
  latest: string;
  major_gap: number;
}

export interface LockfileIssue {
  type: "missing" | "drift" | "duplicate";
  package?: string;
  message: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface DependencyAuditResult {
  workspace: string;
  package_manager: PackageManager;
  vulnerabilities: VulnerabilityAggregate;
  licenses: LicenseAggregate;
  freshness: FreshnessAggregate;
  lockfile: LockfileAggregate;
  duration_ms: number;
  errors: string[];
}

export interface VulnerabilityAggregate {
  total: number;
  by_severity: { critical: number; high: number; moderate: number; low: number };
  findings: Vulnerability[];
}

export interface LicenseAggregate {
  total: number;
  problematic: LicenseInfo[];
  distribution: Record<string, number>;
}

export interface FreshnessAggregate {
  outdated_count: number;
  major_gaps: OutdatedPackage[];
}

export interface LockfileAggregate {
  present: boolean;
  issues: LockfileIssue[];
}

export const CHECK_TIMEOUT_MS = 30_000;
export const CHECK_DEADLINE_MS = CHECK_TIMEOUT_MS + 1_000;
export const MAX_BUFFER = 64 * 1024 * 1024;
export const TOP_N = 20;

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

export function parseDependencyMajor(version: string): number | null {
  const cleaned = version.replace(/^[\^~>=<v\s]+/, "");
  const first = cleaned.split(".")[0];
  if (!first) return null;
  const numberValue = parseInt(first, 10);
  return Number.isNaN(numberValue) ? null : numberValue;
}
