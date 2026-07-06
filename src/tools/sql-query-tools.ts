/** SQL query/reference tracing capability. */

import { getCodeIndex } from "./index-tools.js";
import { searchText } from "./search-tools.js";
import { escapeRegex } from "./sql-shared-tools.js";

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
