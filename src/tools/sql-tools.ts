/**
 * SQL analysis tools — analyze_schema and trace_query.
 * Hidden/discoverable: not in CORE_TOOL_NAMES.
 */

import type { CodeSymbol } from "../types.js";
import { getCodeIndex } from "./index-tools.js";

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

  // Search for references across all indexed files
  const sql_references: SqlReference[] = [];

  // Build a "boundary" regex that handles names with special chars (#, $, @, _).
  // \b only works at word↔non-word transitions; for names starting/ending with
  // non-word chars (like #__joomla_table) we need explicit anchors.
  // Strategy: name must NOT be preceded/followed by an identifier char (a-z, 0-9, _, #, $).
  const IDENT_CHAR = "[a-zA-Z0-9_#$@]";
  const escaped = escapeRegex(tableName);
  // Use lookbehind/lookahead negation. This handles `users`, `#__users`, `wp_users`, `tbl@users`.
  const tableRegex = new RegExp(
    `(?<!${IDENT_CHAR})${escaped}(?!${IDENT_CHAR})`,
    "gi",
  );

  // Fast literal-substring prefilter (much faster than regex test on every line)
  const literalNeedle = tableName.toLowerCase();

  let truncated = false;

  // Pre-build file→symbols map (O(n) instead of O(files*symbols))
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of index.symbols) {
    if (!sym.source) continue;
    const arr = symbolsByFile.get(sym.file);
    if (arr) arr.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  for (const fileEntry of index.files) {
    if (options.file_pattern && !fileEntry.path.includes(options.file_pattern)) continue;

    const fileSymbols = symbolsByFile.get(fileEntry.path) ?? [];
    for (const sym of fileSymbols) {
      if (!sym.source) continue;

      // Fast prefilter: skip whole symbol if name not present at all
      if (!sym.source.toLowerCase().includes(literalNeedle)) continue;

      const sourceLines = sym.source.split("\n");
      for (let lineIdx = 0; lineIdx < sourceLines.length; lineIdx++) {
        const line = sourceLines[lineIdx]!;
        // Per-line literal check first (faster than regex)
        if (!line.toLowerCase().includes(literalNeedle)) continue;
        if (tableRegex.test(line)) {
          tableRegex.lastIndex = 0;
          // Don't include the definition itself as a reference
          const absLine = sym.start_line + lineIdx;
          if (sym === tableSym && lineIdx === 0) continue;

          const refType = classifyReference(line);
          sql_references.push({
            file: sym.file,
            line: absLine,
            context: line.trim().slice(0, 120),
            type: refType,
          });

          if (sql_references.length >= maxRefs) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
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
