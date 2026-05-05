/**
 * Yii2 migrations audit (N2).
 *
 * Yii2 ships its own PHP-DSL migration system — `extends Migration` with
 * `$this->createTable()`, `$this->addColumn()`, `$this->dropTable()`, etc.
 * The generic SQL toolchain (migration_lint, analyze_schema, sql_audit) is
 * auto-loaded for composer.json projects but parses only `.sql` files, so
 * the 379 migrations in tgm-panel are invisible to it.
 *
 * This tool fills that gap. For each migration class we:
 *   1. Map the DSL calls to a structured operation list
 *      (create_table, drop_table, add_column, ...).
 *   2. Run audit checks per migration:
 *        - missing_safe_down       (irreversible)
 *        - drop_without_safety     (drop in safeUp without index/backup hint)
 *        - alter_without_online_ddl (alter on large tables without
 *                                    ALGORITHM=INPLACE, LOCK=NONE for MySQL 8)
 *        - fk_without_index        (addForeignKey on a column without
 *                                   a corresponding createIndex earlier)
 *   3. Surface a per-table operation index (which migrations touch table X).
 *
 * The DSL parser is deliberately regex-based, not tree-sitter. Migration
 * methods follow a small, stable grammar (a few verbs from yii\\db\\Migration
 * with predictable argument shapes) and the AST coverage we'd buy with a
 * full walker isn't worth the cost. The audit is a discovery tool, not a
 * gate — false positives are acceptable, false negatives are the failure
 * mode we minimize.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type YiiMigrationOpKind =
  | "create_table"
  | "drop_table"
  | "rename_table"
  | "add_column"
  | "drop_column"
  | "alter_column"
  | "rename_column"
  | "create_index"
  | "drop_index"
  | "add_primary_key"
  | "drop_primary_key"
  | "add_foreign_key"
  | "drop_foreign_key"
  | "execute_raw_sql"
  | "insert"
  | "update"
  | "delete"
  | "batch_insert";

export interface YiiMigrationOp {
  kind: YiiMigrationOpKind;
  /** Primary table the op touches, when statically determinable. */
  table: string | null;
  /** Column name when applicable (add_column, alter_column, rename_column). */
  column?: string;
  /** Index name when applicable (create_index, drop_index). */
  index_name?: string;
  /** Foreign key constraint name when applicable. */
  fk_name?: string;
  /** 1-based line within the migration class source where the op occurred. */
  line: number;
  /** Raw method name from the DSL call. */
  raw: string;
}

export interface YiiMigrationAuditFinding {
  rule_id:
    | "missing-safe-down"
    | "drop-without-safety"
    | "alter-without-online-ddl"
    | "fk-without-index"
    | "raw-sql-without-comment";
  severity: "high" | "medium" | "low";
  description: string;
  fix: string;
}

export interface YiiMigrationFile {
  file: string;
  class_name: string;
  /** Up-flow operations (`up()` or `safeUp()`). */
  up_ops: YiiMigrationOp[];
  /** Down-flow operations (`down()` or `safeDown()`). */
  down_ops: YiiMigrationOp[];
  /** True iff the migration uses safeUp/safeDown (transactional in Yii2). */
  is_safe_transactional: boolean;
  /** Tables touched by this migration (union of up + down). */
  tables: string[];
  findings: YiiMigrationAuditFinding[];
}

export interface YiiMigrationsAudit {
  repo: string;
  scanned_files: number;
  total_migrations: number;
  /** All migration files keyed by canonical relative path. */
  migrations: YiiMigrationFile[];
  /** Per-table back-index: list of migrations touching that table. */
  by_table: Record<string, string[]>;
  /** Aggregate finding counts by rule. */
  findings_summary: Record<string, number>;
}

// ---------------------------------------------------------------------------
// DSL operation matchers
// ---------------------------------------------------------------------------

interface OpMatcher {
  re: RegExp;
  build: (m: RegExpExecArray, line: number) => YiiMigrationOp;
}

const OP_MATCHERS: OpMatcher[] = [
  {
    // $this->createTable('users', [...])  — plain string OR ::tableName() call.
    re: /\$this->createTable\s*\(\s*(?:['"]([^'"]+)['"]|([\w\\]+)::tableName\s*\(\s*\))/g,
    build: (m, line) => ({
      kind: "create_table",
      table: m[1] ?? m[2] ?? null,
      raw: "createTable",
      line,
    }),
  },
  {
    re: /\$this->dropTable\s*\(\s*(?:['"]([^'"]+)['"]|([\w\\]+)::tableName\s*\(\s*\))/g,
    build: (m, line) => ({
      kind: "drop_table",
      table: m[1] ?? m[2] ?? null,
      raw: "dropTable",
      line,
    }),
  },
  {
    re: /\$this->renameTable\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "rename_table",
      table: m[1]!,
      raw: "renameTable",
      line,
    }),
  },
  {
    re: /\$this->addColumn\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "add_column",
      table: m[1]!,
      column: m[2]!,
      raw: "addColumn",
      line,
    }),
  },
  {
    re: /\$this->dropColumn\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "drop_column",
      table: m[1]!,
      column: m[2]!,
      raw: "dropColumn",
      line,
    }),
  },
  {
    re: /\$this->alterColumn\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "alter_column",
      table: m[1]!,
      column: m[2]!,
      raw: "alterColumn",
      line,
    }),
  },
  {
    re: /\$this->renameColumn\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "rename_column",
      table: m[1]!,
      column: m[2]!,
      raw: "renameColumn",
      line,
    }),
  },
  {
    re: /\$this->createIndex\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "create_index",
      table: m[2]!,
      index_name: m[1]!,
      raw: "createIndex",
      line,
    }),
  },
  {
    re: /\$this->dropIndex\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "drop_index",
      table: m[2]!,
      index_name: m[1]!,
      raw: "dropIndex",
      line,
    }),
  },
  {
    re: /\$this->addPrimaryKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "add_primary_key",
      table: m[2]!,
      index_name: m[1]!,
      raw: "addPrimaryKey",
      line,
    }),
  },
  {
    re: /\$this->dropPrimaryKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "drop_primary_key",
      table: m[2]!,
      index_name: m[1]!,
      raw: "dropPrimaryKey",
      line,
    }),
  },
  {
    // addForeignKey('fk_name', 'table', 'column', 'refTable', 'refColumn', ...)
    re: /\$this->addForeignKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "add_foreign_key",
      fk_name: m[1]!,
      table: m[2]!,
      column: m[3]!,
      raw: "addForeignKey",
      line,
    }),
  },
  {
    re: /\$this->dropForeignKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "drop_foreign_key",
      fk_name: m[1]!,
      table: m[2]!,
      raw: "dropForeignKey",
      line,
    }),
  },
  {
    re: /\$this->execute\s*\(\s*['"`]/g,
    build: (_m, line) => ({
      kind: "execute_raw_sql",
      table: null,
      raw: "execute",
      line,
    }),
  },
  {
    re: /\$this->insert\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "insert",
      table: m[1]!,
      raw: "insert",
      line,
    }),
  },
  {
    re: /\$this->batchInsert\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "batch_insert",
      table: m[1]!,
      raw: "batchInsert",
      line,
    }),
  },
  {
    re: /\$this->update\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "update",
      table: m[1]!,
      raw: "update",
      line,
    }),
  },
  {
    re: /\$this->delete\s*\(\s*['"]([^'"]+)['"]/g,
    build: (m, line) => ({
      kind: "delete",
      table: m[1]!,
      raw: "delete",
      line,
    }),
  },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MIGRATION_BASE_NAMES = new Set(["Migration"]);
const MIGRATION_FILENAME_RE = /(?:^|\/)m\d+_\d+_[\w-]+\.php$/;

function isMigrationHierarchy(
  cls: { name: string; extends?: string[]; source?: string },
  index: { symbols: Array<{ name: string; kind: string; extends?: string[]; source?: string }> },
  visited: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (depth > 5) return false;
  if (visited.has(cls.name)) return false;
  visited.add(cls.name);

  const exts = cls.extends ?? [];
  for (const baseFqcn of exts) {
    const last = baseFqcn.split(/[\\\\]+/).pop() ?? baseFqcn;
    if (MIGRATION_BASE_NAMES.has(last)) return true;
    const baseSym = index.symbols.find(
      (s) => s.kind === "class" && s.name === last,
    );
    if (baseSym && isMigrationHierarchy(baseSym, index, visited, depth + 1)) {
      return true;
    }
  }
  if (!cls.extends && cls.source) {
    return /extends\s+(?:\\?yii\\db\\Migration|Migration)\b/.test(cls.source);
  }
  return false;
}

export async function analyzeYiiMigrations(
  repo: string,
  options?: { file_pattern?: string; rules?: YiiMigrationAuditFinding["rule_id"][] },
): Promise<YiiMigrationsAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const ruleFilter = options?.rules ? new Set(options.rules) : null;
  const filePattern = options?.file_pattern;

  // Find migration class symbols. We require BOTH a Yii2 migration
  // filename pattern AND a Migration ancestor — file name alone is a weak
  // signal (some app code sits in folders named `migrations/`), and class
  // alone misses tgm-panel's `extends Model` data-fix scripts which we
  // intentionally exclude.
  const migrationClasses = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".php")) return false;
    if (!MIGRATION_FILENAME_RE.test(s.file)) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    if (!isMigrationHierarchy(s, index)) return false;
    return true;
  });

  const migrations: YiiMigrationFile[] = [];
  const byTable = new Map<string, Set<string>>();

  for (const cls of migrationClasses) {
    let content: string;
    try {
      content = await readFile(join(index.root, cls.file), "utf-8");
    } catch {
      continue;
    }

    // Locate up/down method bodies. We approximate by finding the method
    // header and grabbing the bytes between the next `{` and a balanced `}`.
    // Yii2 method names: bare `up`/`down` (all lowercase) OR `safeUp`/`safeDown`
    // (camelCase). Regex must accept both cases — the first version used
    // `(?:safe)?Up` which only matched the camelCase form.
    const upInfo = findMethodBody(content, /(?:safeUp|up)/);
    const downInfo = findMethodBody(content, /(?:safeDown|down)/);

    const isSafeTransactional = /\bfunction\s+safe(?:Up|Down)\s*\(/.test(content);

    const upOps = upInfo ? extractOps(upInfo.body, upInfo.lineOffset) : [];
    const downOps = downInfo ? extractOps(downInfo.body, downInfo.lineOffset) : [];

    const tables = new Set<string>();
    for (const op of [...upOps, ...downOps]) {
      if (op.table) tables.add(op.table);
    }
    for (const t of tables) {
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t)!.add(cls.file);
    }

    const findings = auditMigration({
      file: cls.file,
      content,
      upOps,
      downOps,
      hasSafeDown: !!downInfo,
      ruleFilter,
    });

    migrations.push({
      file: cls.file,
      class_name: cls.name,
      up_ops: upOps,
      down_ops: downOps,
      is_safe_transactional: isSafeTransactional,
      tables: [...tables].sort(),
      findings,
    });
  }

  // Stable order: chronological by filename (timestamps sort lex-correctly
  // in Yii2 since `m\d{6}_\d{6}_` always pads zeros).
  migrations.sort((a, b) => a.file.localeCompare(b.file));

  // Aggregate counts.
  const findingsSummary: Record<string, number> = {};
  for (const m of migrations) {
    for (const f of m.findings) {
      findingsSummary[f.rule_id] = (findingsSummary[f.rule_id] ?? 0) + 1;
    }
  }

  const byTableObj: Record<string, string[]> = {};
  for (const [t, files] of byTable.entries()) {
    byTableObj[t] = [...files].sort();
  }

  return {
    repo,
    scanned_files: migrationClasses.length,
    total_migrations: migrations.length,
    migrations,
    by_table: byTableObj,
    findings_summary: findingsSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a method body within a class source by name pattern. Returns the
 * body text (between the `{` after the method header and its matching
 * `}`) plus the 1-based line of the body's opening brace, so per-op line
 * numbers can be computed against the original file.
 *
 * Brace balancing uses a simple counter that ignores braces inside
 * single/double-quoted strings, comments, and heredocs (the last is a
 * best-effort skip — heredocs are rare in migrations).
 */
function findMethodBody(
  source: string,
  nameRe: RegExp,
): { body: string; lineOffset: number } | null {
  // Build a bounded regex for "function NAME(...)"
  const headerRe = new RegExp(
    `\\bfunction\\s+(${nameRe.source})\\s*\\(`,
    "g",
  );
  const headerMatch = headerRe.exec(source);
  if (!headerMatch) return null;
  // Walk to the next `{` after the header.
  const braceStart = source.indexOf("{", headerRe.lastIndex);
  if (braceStart === -1) return null;
  // Balanced match.
  let depth = 1;
  let i = braceStart + 1;
  while (i < source.length && depth > 0) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  const body = source.slice(braceStart + 1, i - 1);
  // 1-based line of the body's opening brace
  const lineOffset = source.slice(0, braceStart).split("\n").length;
  return { body, lineOffset };
}

/**
 * Strip PHP comments (// line, # line, /* … *\/ block) from a source string,
 * preserving line breaks so byte-for-byte line numbers stay aligned with the
 * original. Used by alter-without-online-ddl detection so that developer
 * notes mentioning the hint don't silence the finding.
 *
 * Doesn't try to handle string literals — comments inside strings are rare
 * in migrations and the false-negative impact is minimal.
 */
function stripPhpComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) { i = source.length; }
      else { i = nl; }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) { i = source.length; }
      else {
        // Preserve newlines inside the block so subsequent line numbers
        // stay correct against the original source.
        const block = source.slice(i, end + 2);
        for (const ch of block) if (ch === "\n") out += "\n";
        i = end + 2;
      }
      continue;
    }
    if (c === "#") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) { i = source.length; }
      else { i = nl; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function extractOps(body: string, baseLine: number): YiiMigrationOp[] {
  const ops: YiiMigrationOp[] = [];
  for (const matcher of OP_MATCHERS) {
    matcher.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.re.exec(body)) !== null) {
      const lineInBody = body.slice(0, m.index).split("\n").length - 1;
      ops.push(matcher.build(m, baseLine + lineInBody));
    }
  }
  // Sort by line so callers see operations in source order.
  ops.sort((a, b) => a.line - b.line);
  return ops;
}

interface AuditCtx {
  file: string;
  content: string;
  upOps: YiiMigrationOp[];
  downOps: YiiMigrationOp[];
  hasSafeDown: boolean;
  ruleFilter: Set<YiiMigrationAuditFinding["rule_id"]> | null;
}

function auditMigration(ctx: AuditCtx): YiiMigrationAuditFinding[] {
  const out: YiiMigrationAuditFinding[] = [];
  const include = (id: YiiMigrationAuditFinding["rule_id"]): boolean =>
    !ctx.ruleFilter || ctx.ruleFilter.has(id);

  // missing-safe-down: any up-side op exists but down is empty
  if (include("missing-safe-down") && ctx.upOps.length > 0 && ctx.downOps.length === 0) {
    out.push({
      rule_id: "missing-safe-down",
      severity: "medium",
      description:
        "Migration has up()/safeUp() operations but no down()/safeDown() — irreversible deploys",
      fix: "Implement safeDown() that reverses the up operations (or throw a clear exception explicitly).",
    });
  }

  // alter-without-online-ddl: alter/drop column on tables without an
  // accompanying ALGORITHM=INPLACE/LOCK=NONE hint anywhere in the migration.
  // We require the user to have written a raw `execute()` with the hint OR
  // a comment containing "ALGORITHM=INPLACE" — anything else flags. This
  // is the highest-volume tgm-panel db-audit finding (DB6-001).
  if (include("alter-without-online-ddl")) {
    const destructive = [...ctx.upOps, ...ctx.downOps].filter(
      (o) => o.kind === "alter_column" || o.kind === "drop_column" || o.kind === "drop_table",
    );
    if (destructive.length > 0) {
      // Look for the hint only in code, not comments. A developer note like
      // "TODO: add ALGORITHM=INPLACE" should NOT silence this finding —
      // the hint must actually be in the migration's executed SQL.
      const codeOnly = stripPhpComments(ctx.content);
      const hasOnlineDdl =
        /ALGORITHM\s*=\s*INPLACE/i.test(codeOnly) ||
        /LOCK\s*=\s*NONE/i.test(codeOnly) ||
        /pt-online-schema-change|gh-ost/i.test(codeOnly);
      if (!hasOnlineDdl) {
        out.push({
          rule_id: "alter-without-online-ddl",
          severity: "high",
          description: `Destructive operations (${destructive.map((d) => d.kind).join(", ")}) without explicit ALGORITHM=INPLACE/LOCK=NONE hint — risk of multi-minute lock on large tables under MySQL 8`,
          fix: "Either invoke the destructive ops via raw SQL with ALGORITHM=INPLACE, LOCK=NONE, or document a pt-online-schema-change / gh-ost runbook for large tables.",
        });
      }
    }
  }

  // fk-without-index: addForeignKey on (table, column) where no createIndex
  // on the same (table, column) appears earlier in this migration (or
  // already exists in a previous one — out of scope for a single-file scan).
  if (include("fk-without-index")) {
    const fks = ctx.upOps.filter((o) => o.kind === "add_foreign_key");
    for (const fk of fks) {
      if (!fk.table || !fk.column) continue;
      const idxBefore = ctx.upOps.find(
        (o) =>
          o.kind === "create_index" &&
          o.table === fk.table &&
          o.line < fk.line,
      );
      if (!idxBefore) {
        out.push({
          rule_id: "fk-without-index",
          severity: "medium",
          description: `addForeignKey on ${fk.table}.${fk.column} without createIndex on the same column earlier in this migration — slow FK lookups under load`,
          fix: `Add $this->createIndex('idx_${fk.table}_${fk.column}', '${fk.table}', '${fk.column}') before the addForeignKey call.`,
        });
      }
    }
  }

  // raw-sql-without-comment: raw $this->execute() without any preceding
  // // comment — these need explanation for reviewers. Bounded to first
  // execute() per migration to avoid noise.
  if (include("raw-sql-without-comment")) {
    const execOp = ctx.upOps.find((o) => o.kind === "execute_raw_sql");
    if (execOp) {
      // Heuristic: the line BEFORE the execute() call should be a comment.
      const lines = ctx.content.split("\n");
      const before = lines[execOp.line - 2] ?? "";
      if (!/^\s*(\/\/|#|\/\*)/.test(before)) {
        out.push({
          rule_id: "raw-sql-without-comment",
          severity: "low",
          description:
            "Raw $this->execute() SQL with no preceding comment — review effort goes up sharply when raw SQL appears unexplained",
          fix: "Add a // comment above the execute() line explaining why the DSL wasn't sufficient.",
        });
      }
    }
  }

  return out;
}
