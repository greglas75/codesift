/**
 * SQL analysis tools — analyze_schema and trace_query.
 * Hidden/discoverable: not in CORE_TOOL_NAMES.
 */

import type { CodeSymbol } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { searchText } from "./search-tools.js";

// ── analyze_schema ────────────────────────────────────────

export interface AnalyzeSchemaOptions {
  file_pattern?: string;
  output_format?: "json" | "mermaid";
  include_columns?: boolean;
}

export interface TableInfo {
  name: string;
  file: string;
  line: number;
  columns: Array<{ name: string; type: string }>;
}

export interface Relationship {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  type: "fk" | "self_reference" | "circular";
}

export interface SchemaAnalysisResult {
  tables: TableInfo[];
  views: Array<{ name: string; file: string; line: number }>;
  relationships: Relationship[];
  warnings: string[];
  mermaid?: string;
}

const FK_RE = /REFERENCES\s+(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))\s*\(\s*(?:"([^"]+)"|(\w+))\s*\)/gi;

export async function analyzeSchema(
  repo: string,
  options?: AnalyzeSchemaOptions,
): Promise<SchemaAnalysisResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const includeColumns = options?.include_columns ?? true;
  const filePattern = options?.file_pattern;

  // Collect tables and views from index
  const tables: TableInfo[] = [];
  const views: Array<{ name: string; file: string; line: number }> = [];
  const warnings: string[] = [];

  const tableSymbols = index.symbols.filter((s) =>
    (s.kind === "table" || s.kind === "view") &&
    (!filePattern || s.file.includes(filePattern))
  );

  if (tableSymbols.length === 0) {
    warnings.push("No SQL files indexed in this repository.");
    return { tables, views, relationships: [], warnings };
  }

  // Check for duplicate table names
  const nameCounts = new Map<string, number>();
  for (const sym of tableSymbols) {
    nameCounts.set(sym.name, (nameCounts.get(sym.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      warnings.push(`Duplicate table/view name "${name}" found in ${count} files.`);
    }
  }

  for (const sym of tableSymbols) {
    if (sym.kind === "view") {
      views.push({ name: sym.name, file: sym.file, line: sym.start_line });
      continue;
    }

    const columns: Array<{ name: string; type: string }> = [];
    if (includeColumns) {
      const fields = index.symbols.filter((f) => f.kind === "field" && f.parent === sym.id);
      for (const f of fields) {
        columns.push({ name: f.name, type: f.signature ?? "unknown" });
      }
    }

    tables.push({
      name: sym.name,
      file: sym.file,
      line: sym.start_line,
      columns,
    });
  }

  // Extract FK relationships from column signatures + table-level constraints
  const relationships: Relationship[] = [];

  for (const table of tables) {
    // Column-level REFERENCES
    for (const col of table.columns) {
      FK_RE.lastIndex = 0;
      const m = FK_RE.exec(col.type);
      if (m) {
        const toTable = m[3] ?? m[4] ?? m[1] ?? m[2] ?? "";
        const toCol = m[5] ?? m[6] ?? "id";

        let relType: "fk" | "self_reference" | "circular" = "fk";
        if (toTable === table.name) {
          relType = "self_reference";
        }

        relationships.push({
          from_table: table.name,
          from_column: col.name,
          to_table: toTable,
          to_column: toCol,
          type: relType,
        });
      }
    }

    // Table-level FOREIGN KEY constraints: scan full table source
    const tableSym = index.symbols.find((s) => s.kind === "table" && s.name === table.name);
    if (tableSym?.source) {
      const tableFkRe = /FOREIGN\s+KEY\s*\(\s*(?:"([^"]+)"|(\w+))\s*\)\s*REFERENCES\s+(?:(?:"[^"]+"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))\s*\(\s*(?:"([^"]+)"|(\w+))\s*\)/gi;
      let fkm: RegExpExecArray | null;
      while ((fkm = tableFkRe.exec(tableSym.source)) !== null) {
        const fromCol = fkm[1] ?? fkm[2] ?? "";
        const toTable = fkm[4] ?? fkm[5] ?? fkm[3] ?? "";
        const toCol = fkm[6] ?? fkm[7] ?? "id";

        // Avoid duplicates (column-level already caught this FK)
        if (relationships.some((r) =>
          r.from_table === table.name && r.from_column === fromCol && r.to_table === toTable
        )) continue;

        relationships.push({
          from_table: table.name,
          from_column: fromCol,
          to_table: toTable,
          to_column: toCol,
          type: toTable === table.name ? "self_reference" : "fk",
        });
      }
    }
  }

  // Detect circular references
  detectCircularRefs(relationships, warnings);

  const result: SchemaAnalysisResult = { tables, views, relationships, warnings };

  if (options?.output_format === "mermaid") {
    result.mermaid = generateMermaid(tables, relationships);
  }

  return result;
}

function detectCircularRefs(relationships: Relationship[], warnings: string[]): void {
  // Build adjacency map
  const adj = new Map<string, Set<string>>();
  for (const rel of relationships) {
    if (rel.type === "self_reference") continue;
    if (!adj.has(rel.from_table)) adj.set(rel.from_table, new Set());
    adj.get(rel.from_table)!.add(rel.to_table);
  }

  // DFS cycle detection with visited set
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): void {
    if (inStack.has(node)) {
      warnings.push(`Circular FK reference detected involving "${node}".`);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    for (const neighbor of adj.get(node) ?? []) {
      dfs(neighbor);
    }
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    dfs(node);
  }
}

/**
 * Sanitize a name for Mermaid erDiagram entities.
 * Strips leading non-word chars (e.g. Joomla's `#__`), keeps the rest readable.
 * If the name becomes empty, returns "anon".
 */
function mermaidSafeName(name: string): string {
  // Strip leading non-word chars, replace remaining non-word with _
  const cleaned = name
    .replace(/^[^a-zA-Z0-9]+/, "")    // strip leading #, $, @, etc.
    .replace(/[^a-zA-Z0-9_]/g, "_");
  return cleaned || "anon";
}

/** Sanitize a column type for Mermaid — keep the base type name only (drop size/precision). */
function mermaidSafeType(type: string): string {
  // "int(10) unsigned" → "int", "varchar(255)" → "varchar", "DECIMAL(10,2)" → "decimal"
  const m = /^[a-zA-Z][a-zA-Z0-9_]*/.exec(type);
  return m ? m[0].toLowerCase() : "unknown";
}

function generateMermaid(
  tables: TableInfo[],
  relationships: Relationship[],
): string {
  const lines: string[] = ["erDiagram"];

  for (const table of tables) {
    const safeName = mermaidSafeName(table.name);
    lines.push(`  ${safeName} {`);
    for (const col of table.columns) {
      const typeName = mermaidSafeType(col.type);
      lines.push(`    ${typeName} ${mermaidSafeName(col.name)}`);
    }
    lines.push("  }");
  }

  for (const rel of relationships) {
    const arrow = rel.type === "self_reference" ? "||--o|" : "||--o{";
    lines.push(`  ${mermaidSafeName(rel.from_table)} ${arrow} ${mermaidSafeName(rel.to_table)} : "${mermaidSafeName(rel.from_column)}"`);
  }

  return lines.join("\n");
}

// ── trace_query ───────────────────────────────────────────

export interface TraceQueryOptions {
  table: string;
  include_orm?: boolean;
  file_pattern?: string;
  max_references?: number;
}

export interface SqlReference {
  file: string;
  line: number;
  context: string;
  type: "ddl" | "dml" | "view" | "fk";
}

export interface OrmReference {
  file: string;
  line: number;
  orm: "prisma" | "drizzle";
  model_name: string;
}

export interface TraceQueryResult {
  table_definition: { file: string; line: number; kind: "table" | "view" } | null;
  sql_references: SqlReference[];
  orm_references: OrmReference[];
  warnings: string[];
  truncated: boolean;
}

export async function traceQuery(
  repo: string,
  options: TraceQueryOptions,
): Promise<TraceQueryResult> {
  if (!options.table?.trim()) {
    throw new Error("table parameter is required");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const tableName = options.table.trim();
  const maxRefs = options.max_references ?? 500;
  const includeOrm = options.include_orm ?? true;

  // Find table definition
  const tableSym = index.symbols.find(
    (s) => (s.kind === "table" || s.kind === "view") && s.name === tableName,
  );
  const table_definition = tableSym
    ? { file: tableSym.file, line: tableSym.start_line, kind: tableSym.kind as "table" | "view" }
    : null;

  // Delegate to ripgrep-backed searchText for the fast literal scan, then
  // post-filter in JS with an identifier-char boundary regex. Ripgrep doesn't
  // support JS-style lookbehind, and \b fails on names starting with # or $.
  const IDENT_CHAR = "[a-zA-Z0-9_#$@]";
  const escaped = escapeRegex(tableName);
  const boundaryRegex = new RegExp(
    `(?<!${IDENT_CHAR})${escaped}(?!${IDENT_CHAR})`,
    "i",
  );

  // Fetch a wider window so post-filter losses don't silently cap results.
  const rgMatches = await searchText(repo, tableName, {
    regex: false,
    max_results: Math.max(maxRefs * 3, 500),
    file_pattern: options.file_pattern,
    context_lines: 0,
  });

  const sql_references: SqlReference[] = [];
  let kept = 0;
  let truncated = false;

  for (const m of rgMatches) {
    const text = m.content ?? "";
    if (!boundaryRegex.test(text)) continue;

    // Skip the definition line itself
    if (tableSym && m.file === tableSym.file && m.line === tableSym.start_line) continue;

    sql_references.push({
      file: m.file,
      line: m.line,
      context: text.trim().slice(0, 120),
      type: classifyReference(text),
    });
    kept++;

    if (kept >= maxRefs) {
      truncated = true;
      break;
    }
  }

  const warnings: string[] = [];
  if (truncated) {
    warnings.push(`Results truncated at max_references=${maxRefs}. Pass file_pattern or increase max_references to see more.`);
  }

  // ORM detection
  const orm_references: OrmReference[] = [];
  if (includeOrm) {
    // Prisma detection
    const prismaFiles = index.files.filter((f) => f.path.endsWith(".prisma"));
    for (const pf of prismaFiles) {
      const prismaSymbols = index.symbols.filter((s) => s.file === pf.path);
      for (const sym of prismaSymbols) {
        // Check @@map("tableName") in source
        if (sym.source?.includes(`@@map("${tableName}")`)) {
          orm_references.push({
            file: sym.file,
            line: sym.start_line,
            orm: "prisma",
            model_name: sym.name,
          });
        }
        // Check model name matching table name (case-insensitive)
        if (sym.kind === "class" && sym.name.toLowerCase() === tableName.toLowerCase()) {
          // Avoid duplicates
          if (!orm_references.some((r) => r.file === sym.file && r.model_name === sym.name)) {
            orm_references.push({
              file: sym.file,
              line: sym.start_line,
              orm: "prisma",
              model_name: sym.name,
            });
          }
        }
      }
    }

    // Drizzle detection
    const tsFiles = index.files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".js"));
    for (const tf of tsFiles) {
      const tsSymbols = index.symbols.filter((s) => s.file === tf.path && s.source);
      for (const sym of tsSymbols) {
        if (sym.source?.includes(`pgTable("${tableName}"`) ||
            sym.source?.includes(`mysqlTable("${tableName}"`) ||
            sym.source?.includes(`sqliteTable("${tableName}"`)) {
          orm_references.push({
            file: sym.file,
            line: sym.start_line,
            orm: "drizzle",
            model_name: sym.name,
          });
        }
      }
    }

    // Warn if ORM detected but no references found
    if (prismaFiles.length > 0 && orm_references.length === 0) {
      warnings.push(`ORM detected (Prisma) but no model found for table "${tableName}".`);
    }
  }

  if (!table_definition && sql_references.length === 0) {
    warnings.push(`Table "${tableName}" not found in indexed SQL files. If SQL support was disabled, this is expected.`);
  }

  return { table_definition, sql_references, orm_references, warnings, truncated };
}

function classifyReference(line: string): "ddl" | "dml" | "view" | "fk" {
  const upper = line.toUpperCase().trim();
  if (/^\s*ALTER\s+TABLE/i.test(upper)) return "ddl";
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW/i.test(upper)) return "view";
  if (/REFERENCES/i.test(upper)) return "fk";
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(upper)) return "dml";
  return "dml";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── search_columns ────────────────────────────────────────

export interface SearchColumnsOptions {
  /** Substring to match against column name (case-insensitive). Empty string = no name filter. */
  query: string;
  /** Optional: filter by normalized column type (int, string, float, bool, datetime, json, uuid, bytes) */
  type?: string;
  /** Optional: substring to match against table name */
  table?: string;
  /** Optional: file_pattern to scope */
  file_pattern?: string;
  /** Maximum columns to return (default: 100) */
  max_results?: number;
}

export interface ColumnSearchHit {
  name: string;
  type: string;              // Raw SQL type signature
  normalized_type: string;   // Normalized (int, string, etc.)
  table: string;
  file: string;
  line: number;
}

export interface SearchColumnsResult {
  columns: ColumnSearchHit[];
  total: number;
  truncated: boolean;
}

export async function searchColumns(
  repo: string,
  options: SearchColumnsOptions,
): Promise<SearchColumnsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const queryLower = (options.query ?? "").toLowerCase();
  const typeFilter = options.type?.toLowerCase();
  const tableFilter = options.table?.toLowerCase();
  const filePattern = options.file_pattern;
  const maxResults = options.max_results ?? 100;

  // Build table-id → table-name lookup (only SQL tables, not Prisma models)
  const tableIdToName = new Map<string, { name: string; file: string }>();
  for (const sym of index.symbols) {
    if (sym.kind !== "table") continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    tableIdToName.set(sym.id, { name: sym.name, file: sym.file });
  }

  // Collect field symbols whose parent is a SQL table
  const allHits: ColumnSearchHit[] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "field") continue;
    if (!sym.parent) continue;
    const parent = tableIdToName.get(sym.parent);
    if (!parent) continue;

    const name = sym.name;
    const type = sym.signature ?? "unknown";
    const normalized = normalizeType(type);

    // Apply filters
    if (queryLower && !name.toLowerCase().includes(queryLower)) continue;
    if (typeFilter && normalized !== typeFilter) continue;
    if (tableFilter && !parent.name.toLowerCase().includes(tableFilter)) continue;

    allHits.push({
      name,
      type,
      normalized_type: normalized,
      table: parent.name,
      file: parent.file,
      line: sym.start_line,
    });
  }

  const total = allHits.length;
  const truncated = total > maxResults;
  const columns = truncated ? allHits.slice(0, maxResults) : allHits;

  return { columns, total, truncated };
}

// ── scan_dml_safety ───────────────────────────────────────

export interface DmlFinding {
  rule: string;
  severity: "high" | "medium" | "info";
  file: string;
  line: number;
  context?: string;
  detail: string;
}

export interface ScanDmlSafetyResult {
  findings: DmlFinding[];
  summary: {
    total: number;
    by_rule: Record<string, number>;
    files_scanned: number;
  };
}

/**
 * Scan codebase for unsafe DML patterns in SQL strings.
 * Uses ripgrep to find DML statements, then classifies safety.
 */
export async function scanDmlSafety(
  repo: string,
  options?: { file_pattern?: string; max_results?: number },
): Promise<ScanDmlSafetyResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 200;
  const findings: DmlFinding[] = [];
  const filesScanned = new Set<string>();

  // Pattern 1: DELETE without WHERE
  const delMatches = await searchText(repo, "DELETE FROM", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of delMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Check if WHERE exists after DELETE FROM on the same line or nearby
    if (!/\bWHERE\b/i.test(text)) {
      findings.push({
        rule: "delete-without-where",
        severity: "high",
        file: m.file,
        line: m.line,
        context: text.trim().slice(0, 120),
        detail: `DELETE FROM without WHERE clause — may delete all rows.`,
      });
    }
  }

  // Pattern 2: UPDATE without WHERE
  const updMatches = await searchText(repo, "UPDATE", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of updMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Must contain SET (otherwise it's not a DML UPDATE)
    if (!/\bSET\b/i.test(text)) continue;
    if (!/\bWHERE\b/i.test(text)) {
      findings.push({
        rule: "update-without-where",
        severity: "high",
        file: m.file,
        line: m.line,
        context: text.trim().slice(0, 120),
        detail: `UPDATE...SET without WHERE clause — may update all rows.`,
      });
    }
  }

  // Pattern 3: SELECT * (unbounded read)
  const selMatches = await searchText(repo, "SELECT *", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of selMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Only flag if FROM is present (actual query, not comment/string fragment)
    if (!/\bFROM\b/i.test(text)) continue;
    findings.push({
      rule: "select-star",
      severity: "info",
      file: m.file,
      line: m.line,
      context: text.trim().slice(0, 120),
      detail: `SELECT * — fetches all columns. Consider listing specific fields.`,
    });
  }

  // Deduplicate: same file:line + same rule
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const by_rule: Record<string, number> = {};
  for (const f of deduped) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  return {
    findings: deduped,
    summary: { total: deduped.length, by_rule, files_scanned: filesScanned.size },
  };
}

// ── lint_schema ───────────────────────────────────────────

export interface LintFinding {
  rule: string;
  severity: "warning" | "info";
  table: string;
  detail: string;
  file: string;
  line: number;
}

export interface LintSchemaResult {
  findings: LintFinding[];
  summary: {
    total: number;
    by_rule: Record<string, number>;
  };
  warnings: string[];
}

/**
 * Lint SQL schema for common anti-patterns.
 * Conservative ruleset with near-zero false positive rate:
 * - no-primary-key: table without PRIMARY KEY (serious design smell)
 * - wide-table: table with >20 columns (god table)
 * - duplicate-index-name: same index name defined multiple times
 */
export async function lintSchema(
  repo: string,
  options?: { file_pattern?: string },
): Promise<LintSchemaResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const findings: LintFinding[] = [];
  const warnings: string[] = [];

  const tables = index.symbols.filter((s) => {
    if (s.kind !== "table") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  if (tables.length === 0) {
    warnings.push("No SQL tables found in this repository.");
    return { findings, summary: { total: 0, by_rule: {} }, warnings };
  }

  // Rule 1: no-primary-key — table with no PK field
  for (const table of tables) {
    const source = table.source ?? "";
    const hasPK = /PRIMARY\s+KEY/i.test(source) || /\bSERIAL\b/i.test(source);
    if (!hasPK) {
      findings.push({
        rule: "no-primary-key",
        severity: "warning",
        table: table.name,
        detail: `Table "${table.name}" has no PRIMARY KEY or SERIAL column.`,
        file: table.file,
        line: table.start_line,
      });
    }
  }

  // Rule 2: wide-table — >20 columns
  for (const table of tables) {
    const fields = index.symbols.filter(
      (s) => s.kind === "field" && s.parent === table.id,
    );
    if (fields.length > 20) {
      findings.push({
        rule: "wide-table",
        severity: "warning",
        table: table.name,
        detail: `Table "${table.name}" has ${fields.length} columns (threshold: 20). Consider splitting.`,
        file: table.file,
        line: table.start_line,
      });
    }
  }

  // Rule 3: duplicate-index-name
  const indexNames = new Map<string, { file: string; line: number }>();
  const indexes = index.symbols.filter((s) => {
    if (s.kind !== "index") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });
  for (const idx of indexes) {
    const key = idx.name.toLowerCase();
    if (indexNames.has(key)) {
      const prev = indexNames.get(key)!;
      findings.push({
        rule: "duplicate-index-name",
        severity: "warning",
        table: idx.name,
        detail: `Index "${idx.name}" defined at ${idx.file}:${idx.start_line} duplicates index at ${prev.file}:${prev.line}.`,
        file: idx.file,
        line: idx.start_line,
      });
    } else {
      indexNames.set(key, { file: idx.file, line: idx.start_line });
    }
  }

  // Build summary
  const by_rule: Record<string, number> = {};
  for (const f of findings) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  return {
    findings,
    summary: { total: findings.length, by_rule },
    warnings,
  };
}

// ── diff_migrations ───────────────────────────────────────

export interface MigrationOp {
  operation: string;         // e.g. "CREATE TABLE", "DROP COLUMN", "ALTER TABLE ADD"
  target: string;            // e.g. "users", "users.name"
  severity: "low" | "medium" | "high";
  file: string;
  line: number;
  raw: string;               // trimmed source line
}

export interface DiffMigrationsResult {
  additive: MigrationOp[];      // CREATE TABLE, ADD COLUMN, CREATE INDEX
  modifying: MigrationOp[];     // ALTER TABLE ADD, ALTER COLUMN
  destructive: MigrationOp[];   // DROP TABLE, DROP COLUMN, DROP INDEX
  summary: {
    additive: number;
    modifying: number;
    destructive: number;
    total_files: number;
  };
}

const MIGRATION_PATTERNS: Array<{
  regex: RegExp;
  operation: string;
  category: "additive" | "modifying" | "destructive";
  severity: "low" | "medium" | "high";
  /** Capture group index for the target name */
  targetGroup: number;
}> = [
  // Destructive (high severity)
  { regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP TABLE", category: "destructive", severity: "high", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP COLUMN", category: "destructive", severity: "high", targetGroup: 1 },
  { regex: /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "DROP INDEX", category: "destructive", severity: "medium", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+DROP\s+CONSTRAINT/i, operation: "DROP CONSTRAINT", category: "destructive", severity: "medium", targetGroup: 1 },
  { regex: /TRUNCATE\s+(?:TABLE\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "TRUNCATE", category: "destructive", severity: "high", targetGroup: 1 },

  // Modifying (medium severity)
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ADD\s+COLUMN/i, operation: "ADD COLUMN", category: "modifying", severity: "low", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ADD\s+(?!COLUMN)/i, operation: "ALTER TABLE ADD", category: "modifying", severity: "low", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+ALTER\s+COLUMN/i, operation: "ALTER COLUMN", category: "modifying", severity: "medium", targetGroup: 1 },
  { regex: /ALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+RENAME/i, operation: "RENAME", category: "modifying", severity: "medium", targetGroup: 1 },

  // Additive (low severity) — these overlap with the extractor's DDL patterns
  { regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE TABLE", category: "additive", severity: "low", targetGroup: 1 },
  { regex: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE INDEX", category: "additive", severity: "low", targetGroup: 1 },
  { regex: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i, operation: "CREATE VIEW", category: "additive", severity: "low", targetGroup: 1 },
];

function pickTarget(m: RegExpExecArray, startGroup: number): string {
  for (let i = startGroup; i < m.length; i++) {
    if (m[i]) return m[i]!;
  }
  return "(unknown)";
}

export async function diffMigrations(
  repo: string,
  options?: { file_pattern?: string },
): Promise<DiffMigrationsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;

  // Find .sql files, sorted by name (migration order heuristic)
  const sqlFiles = index.files
    .filter((f) => (f.language === "sql" || f.language === "sql-jinja"))
    .filter((f) => !filePattern || f.file?.includes(filePattern) || f.path.includes(filePattern ?? ""))
    .sort((a, b) => a.path.localeCompare(b.path));

  const additive: MigrationOp[] = [];
  const modifying: MigrationOp[] = [];
  const destructive: MigrationOp[] = [];

  for (const fileEntry of sqlFiles) {
    // Read file source from symbols (each symbol has source)
    // Or reconstruct from all symbols in this file
    const fileSymbols = index.symbols.filter((s) => s.file === fileEntry.path);

    // Collect all raw source lines we can access
    const seenLines = new Set<string>();
    for (const sym of fileSymbols) {
      if (!sym.source) continue;
      for (const line of sym.source.split("\n")) {
        seenLines.add(line);
      }
    }

    // Also scan the file directly for DML patterns not captured as symbols
    // (ALTER, DROP, TRUNCATE aren't symbols — they're imperative ops)
    let fullSource: string | undefined;
    try {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      fullSource = readFileSync(join(index.root, fileEntry.path), "utf-8");
    } catch {
      // File not accessible — use symbol sources only
    }

    const linesToScan = fullSource
      ? fullSource.split("\n")
      : [...seenLines];

    for (let lineIdx = 0; lineIdx < linesToScan.length; lineIdx++) {
      const line = linesToScan[lineIdx]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) continue;

      for (const pat of MIGRATION_PATTERNS) {
        const m = pat.regex.exec(trimmed);
        if (!m) continue;

        const target = pickTarget(m, pat.targetGroup);

        // For DROP COLUMN, include table.column
        let fullTarget = target;
        if (pat.operation === "DROP COLUMN") {
          const colName = pickTarget(m, 5); // groups 5-8 are the column name
          fullTarget = `${target}.${colName}`;
        }

        const op: MigrationOp = {
          operation: pat.operation,
          target: fullTarget,
          severity: pat.severity,
          file: fileEntry.path,
          line: lineIdx + 1,
          raw: trimmed.slice(0, 120),
        };

        switch (pat.category) {
          case "additive": additive.push(op); break;
          case "modifying": modifying.push(op); break;
          case "destructive": destructive.push(op); break;
        }
        break; // first match wins per line
      }
    }
  }

  return {
    additive,
    modifying,
    destructive,
    summary: {
      additive: additive.length,
      modifying: modifying.length,
      destructive: destructive.length,
      total_files: sqlFiles.length,
    },
  };
}

// ── find_orphan_tables ────────────────────────────────────

export interface OrphanTable {
  name: string;
  file: string;
  line: number;
  column_count: number;
}

export interface FindOrphanTablesResult {
  orphans: OrphanTable[];
  total_tables: number;
  orphan_count: number;
}

/**
 * Find SQL tables with zero references outside their own CREATE TABLE definition.
 * Uses ripgrep-backed literal search per table for speed.
 */
export async function findOrphanTables(
  repo: string,
  options?: { file_pattern?: string },
): Promise<FindOrphanTablesResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;

  // Collect all SQL tables
  const tables = index.symbols.filter((s) => {
    if (s.kind !== "table") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  const orphans: OrphanTable[] = [];

  for (const table of tables) {
    // Search for references to this table name via ripgrep
    let rgMatches;
    try {
      rgMatches = await searchText(repo, table.name, {
        regex: false,
        max_results: 20,
        context_lines: 0,
      });
    } catch {
      rgMatches = [];
    }

    // Boundary filter + exclude the definition line itself
    const IDENT_CHAR = "[a-zA-Z0-9_#$@]";
    const escaped = escapeRegex(table.name);
    const boundaryRegex = new RegExp(
      `(?<!${IDENT_CHAR})${escaped}(?!${IDENT_CHAR})`,
      "i",
    );

    const realRefs = rgMatches.filter((m) => {
      const text = m.content ?? "";
      if (!boundaryRegex.test(text)) return false;
      // Exclude the CREATE TABLE definition line
      if (m.file === table.file && m.line === table.start_line) return false;
      // Exclude lines within the CREATE TABLE body (column defs, constraints)
      if (m.file === table.file && m.line > table.start_line && m.line <= table.end_line) return false;
      return true;
    });

    if (realRefs.length === 0) {
      const columnCount = index.symbols.filter(
        (s) => s.kind === "field" && s.parent === table.id,
      ).length;

      orphans.push({
        name: table.name,
        file: table.file,
        line: table.start_line,
        column_count: columnCount,
      });
    }
  }

  return {
    orphans,
    total_tables: tables.length,
    orphan_count: orphans.length,
  };
}

// ── analyze_schema_drift ──────────────────────────────────

export type DriftKind = "extra_in_orm" | "extra_in_sql" | "type_mismatch";

export interface SchemaDrift {
  kind: DriftKind;
  table: string;
  column?: string;
  orm: "prisma" | "drizzle" | "typeorm";
  orm_file?: string;
  orm_line?: number;
  sql_file?: string;
  sql_line?: number;
  orm_type?: string;
  sql_type?: string;
  detail: string;
}

export interface DriftSummary {
  extra_in_orm: number;
  extra_in_sql: number;
  type_mismatches: number;
  total: number;
}

export interface SchemaDriftResult {
  drifts: SchemaDrift[];
  summary: DriftSummary;
  orms_detected: Array<"prisma" | "drizzle" | "typeorm">;
  warnings: string[];
}

export interface AnalyzeSchemaDriftOptions {
  file_pattern?: string;
}

/** Internal: field info parsed from a Prisma model source block */
interface PrismaField {
  name: string;       // Prisma field name (camelCase typically)
  db_name: string;    // If @map("db_col") → that; else snake_case of name
  type: string;       // "Int", "String", "Float", "DateTime", ...
  optional: boolean;
  is_id: boolean;
  is_relation: boolean;
}

interface PrismaModel {
  name: string;        // Prisma model name (PascalCase)
  table: string;       // @@map("...") value or snake_case(name)
  file: string;
  line: number;
  fields: PrismaField[];
}

/** Parse a Prisma model block source → fields + @@map table name */
function parsePrismaModel(sym: CodeSymbol): PrismaModel {
  const source = sym.source ?? "";
  const lines = source.split("\n");
  const fields: PrismaField[] = [];
  let tableName = camelToSnake(sym.name);

  // @@map("table_name")
  const mapMatch = /@@map\s*\(\s*"([^"]+)"\s*\)/.exec(source);
  if (mapMatch) tableName = mapMatch[1]!;

  // Field line pattern: `  fieldName Type? @attr @attr`
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/;
  const RELATION_RE = /@relation/;
  const MAP_ATTR_RE = /@map\s*\(\s*"([^"]+)"\s*\)/;
  // Prisma scalar types — anything else with an uppercase first letter is a model relation
  const SCALAR_TYPES = new Set([
    "Int", "BigInt", "Float", "Decimal", "String", "Boolean", "DateTime", "Json", "Bytes", "Unsupported",
  ]);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip model header, closing brace, comments, attributes
    if (trimmed.startsWith("model ") || trimmed === "" || trimmed === "}") continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

    const m = FIELD_RE.exec(trimmed);
    if (!m) continue;

    const name = m[1]!;
    const type = m[2]!;
    const isList = m[3] === "[]";
    const optional = m[4] === "?";
    const attrs = m[5] ?? "";

    // Skip reserved keywords that aren't fields (e.g. "model", "enum")
    if (/^(model|enum|type|view)$/.test(name)) continue;

    const is_id = /@id\b/.test(attrs);
    // A field is a relation if:
    // 1. It has @relation attr, OR
    // 2. It's a list (Type[]) — always a relation side, OR
    // 3. Its type starts with uppercase AND isn't a built-in scalar (→ custom model)
    const is_relation =
      RELATION_RE.test(attrs) ||
      isList ||
      (/^[A-Z]/.test(type) && !SCALAR_TYPES.has(type));

    // Relations aren't real DB columns — skip for drift purposes
    if (is_relation) continue;

    // @map("db_col") overrides the db name
    const mapField = MAP_ATTR_RE.exec(attrs);
    const db_name = mapField ? mapField[1]! : camelToSnake(name);

    fields.push({ name, db_name, type, optional, is_id, is_relation });
  }

  return {
    name: sym.name,
    table: tableName,
    file: sym.file,
    line: sym.start_line,
    fields,
  };
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z])/g, (_, c: string) => "_" + c.toLowerCase())
    .replace(/^_/, "");
}

/**
 * Normalize a type name for cross-layer comparison.
 * Prisma Int → int, SQL INTEGER → int, Float → float, etc.
 *
 * Handles signatures like "TEXT NOT NULL", "SERIAL PRIMARY KEY", "int(10) unsigned".
 * Extracts the base type word, then groups by semantic equivalence.
 */
function normalizeType(raw: string): string {
  // Take the first word only (strip modifiers, constraints, size).
  // "TEXT NOT NULL" → "text", "int(10) unsigned" → "int", "DECIMAL(10,2)" → "decimal"
  const firstWord = /[a-zA-Z]+/.exec(raw)?.[0]?.toLowerCase() ?? "";

  // Group equivalents
  if (/^(int|integer|smallint|bigint|serial|bigserial|smallserial|tinyint|mediumint)$/.test(firstWord)) return "int";
  if (/^(float|real|double|decimal|numeric|money)$/.test(firstWord)) return "float";
  if (/^(text|varchar|char|string|nvarchar|longtext|mediumtext|tinytext)$/.test(firstWord)) return "string";
  if (/^(bool|boolean|bit)$/.test(firstWord)) return "bool";
  if (/^(timestamp|timestamptz|datetime|date|time|timetz)$/.test(firstWord)) return "datetime";
  if (/^(json|jsonb)$/.test(firstWord)) return "json";
  if (/^(uuid)$/.test(firstWord)) return "uuid";
  if (/^(bytea|blob|binary|longblob|mediumblob|tinyblob)$/.test(firstWord)) return "bytes";
  return firstWord || "unknown";
}

export async function analyzeSchemaDrift(
  repo: string,
  options?: AnalyzeSchemaDriftOptions,
): Promise<SchemaDriftResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const drifts: SchemaDrift[] = [];
  const warnings: string[] = [];
  const orms_detected: Array<"prisma" | "drizzle" | "typeorm"> = [];

  // Collect SQL tables and fields
  const sqlTables = new Map<string, {
    file: string;
    line: number;
    columns: Map<string, { type: string; file: string; line: number }>;
  }>();

  for (const sym of index.symbols) {
    if (sym.kind !== "table") continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    const columns = new Map<string, { type: string; file: string; line: number }>();
    const fields = index.symbols.filter(
      (f) => f.kind === "field" && f.parent === sym.id,
    );
    for (const f of fields) {
      columns.set(f.name.toLowerCase(), {
        type: f.signature ?? "unknown",
        file: f.file,
        line: f.start_line,
      });
    }
    sqlTables.set(sym.name.toLowerCase(), {
      file: sym.file,
      line: sym.start_line,
      columns,
    });
  }

  // Collect Prisma models (kind === "class" in prisma extractor)
  const prismaModels: PrismaModel[] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "class") continue;
    if (!sym.file.endsWith(".prisma")) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    prismaModels.push(parsePrismaModel(sym));
  }
  if (prismaModels.length > 0) orms_detected.push("prisma");

  // TODO: Drizzle and TypeORM collection (v1.2)

  if (orms_detected.length === 0) {
    warnings.push("No ORM models found in repository. analyze_schema_drift requires at least one ORM (Prisma/Drizzle/TypeORM).");
    return {
      drifts: [],
      summary: { extra_in_orm: 0, extra_in_sql: 0, type_mismatches: 0, total: 0 },
      orms_detected,
      warnings,
    };
  }

  // Cross-reference: Prisma models vs SQL tables
  const matchedSqlTables = new Set<string>();

  for (const model of prismaModels) {
    const sqlTable = sqlTables.get(model.table.toLowerCase());
    if (!sqlTable) {
      // Prisma model has no matching SQL table → extra_in_orm
      drifts.push({
        kind: "extra_in_orm",
        table: model.table,
        orm: "prisma",
        orm_file: model.file,
        orm_line: model.line,
        detail: `Prisma model "${model.name}" maps to table "${model.table}" which does not exist in SQL schema.`,
      });
      continue;
    }
    matchedSqlTables.add(model.table.toLowerCase());

    // Compare fields
    const sqlCols = sqlTable.columns;
    const matchedSqlCols = new Set<string>();

    for (const field of model.fields) {
      const sqlCol = sqlCols.get(field.db_name.toLowerCase());
      if (!sqlCol) {
        drifts.push({
          kind: "extra_in_orm",
          table: model.table,
          column: field.name,
          orm: "prisma",
          orm_file: model.file,
          orm_line: model.line,
          orm_type: field.type,
          detail: `Prisma field "${model.name}.${field.name}" (maps to "${field.db_name}") does not exist in SQL table "${model.table}".`,
        });
        continue;
      }
      matchedSqlCols.add(field.db_name.toLowerCase());

      // Type compatibility check
      const ormNorm = normalizeType(field.type);
      const sqlNorm = normalizeType(sqlCol.type);
      if (ormNorm !== sqlNorm && ormNorm !== "unknown" && sqlNorm !== "unknown") {
        drifts.push({
          kind: "type_mismatch",
          table: model.table,
          column: field.name,
          orm: "prisma",
          orm_file: model.file,
          orm_line: model.line,
          sql_file: sqlCol.file,
          sql_line: sqlCol.line,
          orm_type: field.type,
          sql_type: sqlCol.type,
          detail: `Type mismatch: Prisma "${model.name}.${field.name}" is "${field.type}" (${ormNorm}) but SQL "${model.table}.${field.db_name}" is "${sqlCol.type}" (${sqlNorm}).`,
        });
      }
    }

    // SQL columns not covered by any Prisma field → extra_in_sql (column-level)
    for (const [colName, sqlCol] of sqlCols) {
      if (matchedSqlCols.has(colName)) continue;
      // Don't flag common auto-columns that Prisma often omits
      if (/^(created_at|updated_at|deleted_at)$/i.test(colName)) continue;
      drifts.push({
        kind: "extra_in_sql",
        table: model.table,
        column: colName,
        orm: "prisma",
        sql_file: sqlCol.file,
        sql_line: sqlCol.line,
        sql_type: sqlCol.type,
        detail: `SQL column "${model.table}.${colName}" has no corresponding field in Prisma model "${model.name}".`,
      });
    }
  }

  // SQL tables with no Prisma model → extra_in_sql (table-level)
  for (const [tableName, sqlTable] of sqlTables) {
    if (matchedSqlTables.has(tableName)) continue;
    drifts.push({
      kind: "extra_in_sql",
      table: tableName,
      orm: "prisma",
      sql_file: sqlTable.file,
      sql_line: sqlTable.line,
      detail: `SQL table "${tableName}" has no corresponding Prisma model.`,
    });
  }

  const summary: DriftSummary = {
    extra_in_orm: drifts.filter((d) => d.kind === "extra_in_orm").length,
    extra_in_sql: drifts.filter((d) => d.kind === "extra_in_sql").length,
    type_mismatches: drifts.filter((d) => d.kind === "type_mismatch").length,
    total: drifts.length,
  };

  // Heuristic warning: if >50% of ORM tables have no SQL counterpart, this is
  // likely a Prisma-migrate style project where SQL files are incremental
  // migrations, not a full schema snapshot. In that case table-level drift
  // is noise — the real signal is field-level drift on matched tables.
  const totalOrmTables = prismaModels.length;
  const orphanOrmTables = drifts.filter(
    (d) => d.kind === "extra_in_orm" && !d.column,
  ).length;
  if (totalOrmTables > 0 && orphanOrmTables / totalOrmTables > 0.5) {
    warnings.push(
      `${orphanOrmTables}/${totalOrmTables} Prisma models have no SQL counterpart. ` +
      `This likely means the project uses Prisma Migrate (incremental migrations) ` +
      `rather than a full schema.sql snapshot. Field-level drifts on matched tables ` +
      `are still meaningful; ignore table-level extra_in_orm drifts in this mode.`,
    );
  }

  return { drifts, summary, orms_detected, warnings };
}
