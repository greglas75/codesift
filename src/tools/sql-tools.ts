/**
 * SQL analysis tools public barrel.
 *
 * Capability implementations live in focused sql-*-tools modules; this file
 * preserves the existing import path used by MCP registration and tests.
 */

export type { SqlDialect } from "./sql-shared-tools.js";
export { detectSqlDialect } from "./sql-shared-tools.js";

export type {
  AnalyzeSchemaOptions,
  Relationship,
  SchemaAnalysisResult,
  TableInfo,
} from "./sql-schema-tools.js";
export { analyzeSchema } from "./sql-schema-tools.js";

export type {
  OrmReference,
  SqlReference,
  TraceQueryOptions,
  TraceQueryResult,
} from "./sql-query-tools.js";
export { traceQuery } from "./sql-query-tools.js";

export type {
  ColumnSearchHit,
  SearchColumnsOptions,
  SearchColumnsResult,
} from "./sql-column-tools.js";
export { searchColumns } from "./sql-column-tools.js";

export type {
  SchemaComplexityResult,
  TableComplexity,
} from "./sql-complexity-tools.js";
export { analyzeSchemaComplexity } from "./sql-complexity-tools.js";

export type {
  DmlFinding,
  ScanDmlSafetyResult,
} from "./sql-dml-safety-tools.js";
export { scanDmlSafety } from "./sql-dml-safety-tools.js";

export type {
  LintFinding,
  LintSchemaResult,
} from "./sql-lint-schema-tools.js";
export { lintSchema } from "./sql-lint-schema-tools.js";

export type {
  DiffMigrationsResult,
  MigrationOp,
} from "./sql-migration-diff-tools.js";
export { diffMigrations } from "./sql-migration-diff-tools.js";

export type {
  FindOrphanTablesResult,
  OrphanTable,
} from "./sql-orphan-table-tools.js";
export { findOrphanTables } from "./sql-orphan-table-tools.js";

export type {
  AnalyzeSchemaDriftOptions,
  DriftKind,
  DriftSummary,
  SchemaDrift,
  SchemaDriftResult,
} from "./sql-drift-tools.js";
export { analyzeSchemaDrift } from "./sql-drift-tools.js";

export type {
  SqlAuditCheck,
  SqlAuditGate,
  SqlAuditOptions,
  SqlAuditResult,
} from "./sql-audit-tools.js";
export { sqlAudit } from "./sql-audit-tools.js";
