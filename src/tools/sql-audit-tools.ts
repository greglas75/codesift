/** Composite SQL audit capability. */

import { analyzeSchemaComplexity } from "./sql-complexity-tools.js";
import { scanDmlSafety } from "./sql-dml-safety-tools.js";
import { analyzeSchemaDrift } from "./sql-drift-tools.js";
import { lintSchema } from "./sql-lint-schema-tools.js";
import { findOrphanTables } from "./sql-orphan-table-tools.js";

export type SqlAuditCheck = "drift" | "orphan" | "lint" | "dml" | "complexity";

export interface SqlAuditOptions {
  /** Which checks to run (default: all) */
  checks?: SqlAuditCheck[];
  /** Scope to files matching pattern */
  file_pattern?: string;
  /** Optional: max_results for dml scan */
  max_results?: number;
}

export interface SqlAuditGate {
  check: SqlAuditCheck;
  pass: boolean;
  critical: boolean;
  finding_count: number;
  /** Per-check result shape differs; let consumers drill into .data if needed */
  data: unknown;
  /** One-line human-readable summary */
  summary: string;
}

export interface SqlAuditResult {
  gates: SqlAuditGate[];
  summary: {
    total_findings: number;
    critical_findings: number;
    gates_run: number;
    gates_passed: number;
    gates_failed: number;
  };
  warnings: string[];
}

const DEFAULT_SQL_AUDIT_CHECKS: SqlAuditCheck[] = ["drift", "orphan", "lint", "dml", "complexity"];

/**
 * Composite SQL audit — runs multiple diagnostic gates in a single call.
 * Mirrors framework_audit / nest_audit / audit_scan pattern.
 *
 * Individual gate functions (analyzeSchemaDrift, findOrphanTables, lintSchema,
 * scanDmlSafety, analyzeSchemaComplexity) remain exported for internal use
 * but are NOT registered as separate MCP tools. sql_audit is the single
 * discoverable entry point.
 */
export async function sqlAudit(
  repo: string,
  options?: SqlAuditOptions,
): Promise<SqlAuditResult> {
  const checks = options?.checks ?? DEFAULT_SQL_AUDIT_CHECKS;
  const filePattern = options?.file_pattern;
  const gates: SqlAuditGate[] = [];
  const warnings: string[] = [];

  // Build option objects with only defined fields (for exactOptionalPropertyTypes compat)
  const scopedOpts: { file_pattern?: string } = {};
  if (filePattern !== undefined) scopedOpts.file_pattern = filePattern;

  // Gate 1: schema_drift (ORM ↔ SQL drift)
  if (checks.includes("drift")) {
    const drift = await analyzeSchemaDrift(repo, scopedOpts);
    const criticalCount = drift.summary.type_mismatches;
    gates.push({
      check: "drift",
      pass: drift.summary.total === 0,
      critical: criticalCount > 0,
      finding_count: drift.summary.total,
      data: drift,
      summary: drift.summary.total === 0
        ? "No schema drift detected"
        : `${drift.summary.total} drift${drift.summary.total === 1 ? "" : "s"}: ${drift.summary.extra_in_orm} extra in ORM, ${drift.summary.extra_in_sql} extra in SQL, ${drift.summary.type_mismatches} type mismatches`,
    });
    for (const w of drift.warnings) warnings.push(`drift: ${w}`);
  }

  // Gate 2: orphan_tables
  if (checks.includes("orphan")) {
    const orphan = await findOrphanTables(repo, scopedOpts);
    gates.push({
      check: "orphan",
      pass: orphan.orphan_count === 0,
      critical: false,
      finding_count: orphan.orphan_count,
      data: orphan,
      summary: orphan.orphan_count === 0
        ? `No orphan tables (${orphan.total_tables} tables scanned)`
        : `${orphan.orphan_count}/${orphan.total_tables} tables with zero references`,
    });
  }

  // Gate 3: lint_schema
  if (checks.includes("lint")) {
    const lint = await lintSchema(repo, scopedOpts);
    gates.push({
      check: "lint",
      pass: lint.summary.total === 0,
      critical: false,
      finding_count: lint.summary.total,
      data: lint,
      summary: lint.summary.total === 0
        ? "No schema lint violations"
        : `${lint.summary.total} lint violation${lint.summary.total === 1 ? "" : "s"}: ${Object.entries(lint.summary.by_rule).map(([r, n]) => `${r}=${n}`).join(", ")}`,
    });
    for (const w of lint.warnings) warnings.push(`lint: ${w}`);
  }

  // Gate 4: dml_safety
  if (checks.includes("dml")) {
    const dmlOpts: { file_pattern?: string; max_results?: number } = {};
    if (filePattern !== undefined) dmlOpts.file_pattern = filePattern;
    if (options?.max_results !== undefined) dmlOpts.max_results = options.max_results;
    const dml = await scanDmlSafety(repo, dmlOpts);
    const highSeverity = dml.findings.filter((f) => f.severity === "high").length;
    gates.push({
      check: "dml",
      pass: highSeverity === 0,
      critical: highSeverity > 0,
      finding_count: dml.summary.total,
      data: dml,
      summary: dml.summary.total === 0
        ? `No DML safety issues (${dml.summary.files_scanned} files scanned)`
        : `${dml.summary.total} DML issue${dml.summary.total === 1 ? "" : "s"} (${highSeverity} high risk): ${Object.entries(dml.summary.by_rule).map(([r, n]) => `${r}=${n}`).join(", ")}`,
    });
  }

  // Gate 5: schema_complexity (god tables)
  if (checks.includes("complexity")) {
    const complexityOpts: { file_pattern?: string; top_n?: number } = { top_n: 10 };
    if (filePattern !== undefined) complexityOpts.file_pattern = filePattern;
    const complexity = await analyzeSchemaComplexity(repo, complexityOpts);
    // Threshold: score >= 25 = "needs refactor" (20 cols + 1 FK + 1 idx → 24.5)
    const godTables = complexity.tables.filter((t) => t.score >= 25);
    gates.push({
      check: "complexity",
      pass: godTables.length === 0,
      critical: false,
      finding_count: godTables.length,
      data: complexity,
      summary: godTables.length === 0
        ? `No god tables detected (${complexity.tables.length} tables analyzed)`
        : `${godTables.length} god table${godTables.length === 1 ? "" : "s"}: ${godTables.slice(0, 3).map((t) => `${t.name}(${t.score.toFixed(0)})`).join(", ")}${godTables.length > 3 ? "..." : ""}`,
    });
  }

  const total_findings = gates.reduce((sum, g) => sum + g.finding_count, 0);
  const critical_findings = gates
    .filter((g) => g.critical)
    .reduce((sum, g) => sum + g.finding_count, 0);
  const gates_passed = gates.filter((g) => g.pass).length;
  const gates_failed = gates.filter((g) => !g.pass).length;

  return {
    gates,
    summary: {
      total_findings,
      critical_findings,
      gates_run: gates.length,
      gates_passed,
      gates_failed,
    },
    warnings,
  };
}
