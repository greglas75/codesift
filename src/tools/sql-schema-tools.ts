/** SQL schema analysis capability. */

import { getCodeIndex } from "./index-tools.js";
import { detectSqlDialect, type SqlDialect } from "./sql-shared-tools.js";

export interface AnalyzeSchemaOptions {
  file_pattern?: string;
  output_format?: "json" | "mermaid";
  include_columns?: boolean;
  /**
   * Force a specific dialect. When omitted (or set to "auto"), the dialect is
   * inferred from schema source via {@link detectSqlDialect} — content fingerprints
   * like ENGINE=InnoDB, AUTO_INCREMENT, SERIAL, JSONB, AUTOINCREMENT, IDENTITY.
   */
  dialect?: SqlDialect | "auto";
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
  /**
   * Detected (or forced) SQL dialect. "unknown" when no fingerprint matched
   * — typical for ORM-only repos where the canonical schema lives in TS/Prisma.
   */
  detected_dialect: SqlDialect;
}

const FK_RE = /REFERENCES\s+(?:(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\(\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\)/gi;

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
    return { tables, views, relationships: [], warnings, detected_dialect: "unknown" };
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
        // Prefer table groups (5..8); fall back to schema groups (1..4) on weird inputs.
        const toTable = m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
        const toCol = m[9] ?? m[10] ?? m[11] ?? m[12] ?? "id";

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
      // Table-level FOREIGN KEY constraint — same identifier shapes as FK_RE.
      // Capture layout:
      //   1..4: from-column "..", `..`, [..], unquoted
      //   5..8: schema-qualified prefix (any quoting) — discarded
      //   9..12: target table
      //   13..16: target column
      const tableFkRe = /FOREIGN\s+KEY\s*\(\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\)\s*REFERENCES\s+(?:(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\(\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\)/gi;
      let fkm: RegExpExecArray | null;
      while ((fkm = tableFkRe.exec(tableSym.source)) !== null) {
        const fromCol = fkm[1] ?? fkm[2] ?? fkm[3] ?? fkm[4] ?? "";
        const toTable = fkm[9] ?? fkm[10] ?? fkm[11] ?? fkm[12] ?? "";
        const toCol = fkm[13] ?? fkm[14] ?? fkm[15] ?? fkm[16] ?? "id";

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

  // Resolve dialect: explicit > auto-detect from concatenated table sources.
  // Concatenation is bounded by tableSymbols (already filtered by file_pattern),
  // so the cost stays linear in the analyzed schema.
  let detected_dialect: SqlDialect;
  const explicit = options?.dialect;
  if (explicit && explicit !== "auto") {
    detected_dialect = explicit;
  } else {
    let probe = "";
    for (const sym of tableSymbols) {
      if (sym.source) probe += sym.source + "\n";
      if (probe.length > 32_000) break; // 32 KB cap — enough fingerprint surface
    }
    detected_dialect = detectSqlDialect(probe);
  }

  const result: SchemaAnalysisResult = {
    tables,
    views,
    relationships,
    warnings,
    detected_dialect,
  };

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
