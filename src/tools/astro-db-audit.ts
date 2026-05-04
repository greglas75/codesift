/**
 * Astro DB audit. Orchestrates astro-db-parser (Task 4) for schema extraction
 * and adds runtime detectors:
 *   DB02 N+1                — db.select inside for/while/forEach loop
 *   DB03 missing-fk-index   — FK column without explicit indexes entry
 *   DB04 reference-cycle    — table references form a cycle
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getProperty } from "./astro-helpers.js";
import { parseAstroDbSchema, type TableDef } from "./astro-db-parser.js";

export interface DbAuditIssue {
  code: "DB00" | "DB02" | "DB03" | "DB04";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
  column?: string;
}

export interface DbAuditResult {
  config_file: string | null;
  tables: TableDef[];
  n_plus_one: DbAuditIssue[];
  missing_indexes: { column: string; table: string; code: "DB03" }[];
  issues: DbAuditIssue[];
  summary: { tables_total: number; issues_total: number };
}

const CANDIDATES = ["db/config.ts", "db/config.js", "db/config.mjs", "src/db/config.ts"];

async function findDbConfig(root: string): Promise<{ abs: string; rel: string } | null> {
  for (const rel of CANDIDATES) {
    const abs = join(root, rel);
    if (existsSync(abs)) return { abs, rel };
  }
  return null;
}

async function readIndexedColumns(content: string): Promise<Set<string>> {
  // Parse indexes scoped per table — return set of "TableName.columnName" entries.
  // Avoids cross-table contamination where shared FK column names bleed across tables.
  await initParser();
  const parser = await getParser("typescript");
  if (!parser) return new Set();
  let tree;
  try { tree = parser.parse(content); } catch { return new Set(); }
  try {
    const indexed = new Set<string>();
    for (const lex of tree.rootNode.descendantsOfType("lexical_declaration")) {
      for (const v of lex.namedChildren) {
        if (v.type !== "variable_declarator") continue;
        const nameNode = v.childForFieldName("name");
        const valueNode = v.childForFieldName("value");
        if (!nameNode || !valueNode || valueNode.type !== "call_expression") continue;
        const fn = valueNode.childForFieldName("function");
        if (!fn || fn.text !== "defineTable") continue;
        const args = valueNode.childForFieldName("arguments");
        const obj = args?.namedChildren.find((n) => n.type === "object");
        if (!obj) continue;
        const idx = getProperty(obj, "indexes");
        if (!idx || idx.type !== "array") continue;
        for (const entry of idx.namedChildren) {
          if (entry.type !== "object") continue;
          const on = getProperty(entry, "on");
          if (!on || on.type !== "array") continue;
          for (const col of on.namedChildren) {
            if (col.type === "string") indexed.add(`${nameNode.text}.${col.text.slice(1, -1)}`);
          }
        }
      }
    }
    return indexed;
  } finally { tree.delete(); }
}

function detectCycle(tables: TableDef[]): boolean {
  // Build adjacency: tableName → set of referenced tableNames
  const graph = new Map<string, Set<string>>();
  for (const t of tables) {
    const targets = new Set<string>();
    for (const c of t.columns) {
      if (c.references) {
        const target = c.references.split(".")[0];
        if (target && target !== t.name) targets.add(target);
      }
    }
    graph.set(t.name, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function dfs(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) if (dfs(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  for (const name of graph.keys()) if (dfs(name)) return true;
  return false;
}

const DB_OP = /^(select|insert|update|delete)$/;

/** AST-based detection: db.<op>(...) call inside any loop ancestor (for/while/forEach). */
async function findNPlusOneSites(source: string, file: string): Promise<DbAuditIssue[]> {
  await initParser();
  const ext = file.endsWith(".astro") ? "typescript" : (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs")) ? "javascript" : "typescript";
  const parser = await getParser(ext);
  if (!parser) return [];
  let tree;
  try { tree = parser.parse(source); } catch { return []; }
  try {
    const issues: DbAuditIssue[] = [];
    for (const call of tree.rootNode.descendantsOfType("call_expression")) {
      const fn = call.childForFieldName("function");
      if (!fn || fn.type !== "member_expression") continue;
      const obj = fn.childForFieldName("object");
      const prop = fn.childForFieldName("property");
      if (!obj || obj.text !== "db" || !prop || !DB_OP.test(prop.text)) continue;

      // Walk up to see if any ancestor is a for/while/forEach loop body.
      let cur: Parser.SyntaxNode | null = call;
      while (cur) {
        if (cur.type === "for_statement" || cur.type === "for_in_statement" || cur.type === "while_statement") {
          issues.push({ code: "DB02", severity: "warning", message: `db.${prop.text}() inside ${cur.type.replace("_", " ")} — likely N+1`, file, line: call.startPosition.row + 1 });
          break;
        }
        // forEach detection: the call is inside an arrow_function whose parent
        // call_expression has function .forEach
        if (cur.type === "arrow_function" || cur.type === "function") {
          const parent = cur.parent;
          if (parent && parent.type === "arguments") {
            const grand = parent.parent;
            if (grand && grand.type === "call_expression") {
              const grandFn = grand.childForFieldName("function");
              if (grandFn && grandFn.type === "member_expression") {
                const grandProp = grandFn.childForFieldName("property");
                if (grandProp && (grandProp.text === "forEach" || grandProp.text === "map")) {
                  issues.push({ code: "DB02", severity: "warning", message: `db.${prop.text}() inside .${grandProp.text}() — likely N+1`, file, line: call.startPosition.row + 1 });
                  break;
                }
              }
            }
          }
        }
        cur = cur.parent;
      }
    }
    return issues;
  } finally { tree.delete(); }
}

export async function auditDbFromRoot(root: string): Promise<DbAuditResult> {
  const cfg = await findDbConfig(root);
  if (!cfg) return { config_file: null, tables: [], n_plus_one: [], missing_indexes: [], issues: [], summary: { tables_total: 0, issues_total: 0 } };

  let configSource: string;
  try { configSource = await readFile(cfg.abs, "utf-8"); } catch {
    return { config_file: cfg.rel, tables: [], n_plus_one: [], missing_indexes: [], issues: [{ code: "DB00", severity: "error", message: "Cannot read db config", file: cfg.rel, line: 1 }], summary: { tables_total: 0, issues_total: 1 } };
  }

  const parsed = await parseAstroDbSchema(configSource);
  const tables = parsed.tables;
  const indexedCols = await readIndexedColumns(configSource);

  const issues: DbAuditIssue[] = [];

  if (detectCycle(tables)) {
    issues.push({ code: "DB04", severity: "warning", message: "Reference cycle detected between tables — review FK design", file: cfg.rel, line: 1 });
  }

  // Missing FK indexes
  const missing_indexes: { column: string; table: string; code: "DB03" }[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.references && !indexedCols.has(`${t.name}.${c.name}`)) {
        missing_indexes.push({ column: c.name, table: t.name, code: "DB03" });
        issues.push({ code: "DB03", severity: "warning", message: `FK column ${t.name}.${c.name} has no explicit index — slow joins likely`, file: cfg.rel, line: 1, column: c.name });
      }
    }
  }

  // N+1 scan across project source
  const files = await walkDirectory(root, {
    maxFiles: 5000, relative: true,
    fileFilter: (ext) => ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".astro" || ext === ".mjs",
  });
  const n_plus_one: DbAuditIssue[] = [];
  for (const rel of files) {
    if (rel.startsWith("db/")) continue;
    let src: string;
    try { src = await readFile(join(root, rel), "utf-8"); } catch { continue; }
    if (!/\bdb\s*\./.test(src)) continue;
    // For .astro files, parse only the frontmatter section (between ---/---).
    const toParse = rel.endsWith(".astro")
      ? (src.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "")
      : src;
    if (!toParse) continue;
    const found = await findNPlusOneSites(toParse, rel);
    n_plus_one.push(...found);
    issues.push(...found);
  }

  return {
    config_file: cfg.rel,
    tables,
    n_plus_one,
    missing_indexes,
    issues,
    summary: { tables_total: tables.length, issues_total: issues.length },
  };
}

export async function astroDbAudit(args: { project_root?: string; repo?: string }): Promise<DbAuditResult> {
  if (args.project_root) return auditDbFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { config_file: null, tables: [], n_plus_one: [], missing_indexes: [], issues: [], summary: { tables_total: 0, issues_total: 0 } };
  return auditDbFromRoot(index.root);
}
