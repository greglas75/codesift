// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  model: string;
  method: string;
  where?: Record<string, unknown> | undefined;
  select?: string[] | undefined;
  include?: string[] | undefined;
  orderBy?: string[] | undefined;
  take?: number | undefined;
  skip?: number | undefined;
}

export interface ExplainQueryResult {
  sql: string;
  explain_command: string;
  warnings: string[];
  optimization_hints: string[];
  parsed: ParsedQuery;
}

type Dialect = "postgresql" | "mysql" | "sqlite";

// ---------------------------------------------------------------------------
// Prisma call parser (regex-based MVP)
// ---------------------------------------------------------------------------

/**
 * Extract the content between matching braces, starting after the first `{`.
 * Returns the inner content (excluding outer braces), or null if not found.
 */
function extractBraceContent(code: string, startIdx: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = startIdx; i < code.length; i++) {
    if (code[i] === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (code[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return code.slice(start, i);
      }
    }
  }
  return null;
}

/**
 * Extract simple key-value fields from a Prisma options object.
 * Works for flat structures like { email: "x", role: "admin" }.
 */
function extractFields(content: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const fieldRegex = /(\w+)\s*:\s*(?:"([^"]*)"|\{[^}]*\}|(\w+))/g;
  let match;
  while ((match = fieldRegex.exec(content)) !== null) {
    fields[match[1]!] = match[2] ?? match[3] ?? "...";
  }
  return fields;
}

/**
 * Extract array of field names from select/include: { field: true, ... }
 */
function extractSelectedFields(content: string, key: string): string[] | undefined {
  const keyIdx = content.indexOf(`${key}:`);
  if (keyIdx === -1) return undefined;

  const braceContent = extractBraceContent(content, keyIdx);
  if (!braceContent) return undefined;

  const fields: string[] = [];
  const fieldRegex = /(\w+)\s*:\s*true/g;
  let match;
  while ((match = fieldRegex.exec(braceContent)) !== null) {
    fields.push(match[1]!);
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * Extract orderBy fields: { field: "asc" } or [{ field: "asc" }]
 */
function extractOrderBy(content: string): string[] | undefined {
  const keyIdx = content.indexOf("orderBy:");
  if (keyIdx === -1) return undefined;

  // Look for the content after orderBy:
  const afterKey = content.slice(keyIdx + 8).trim();
  const orders: string[] = [];
  const orderRegex = /(\w+)\s*:\s*["']?(asc|desc)["']?/gi;
  let match;
  while ((match = orderRegex.exec(afterKey)) !== null) {
    orders.push(`${match[1]} ${match[2]!.toUpperCase()}`);
  }
  return orders.length > 0 ? orders : undefined;
}

/**
 * Extract numeric value for take/skip
 */
function extractNumericField(content: string, key: string): number | undefined {
  const regex = new RegExp(`${key}\\s*:\\s*(\\d+)`);
  const match = regex.exec(content);
  return match ? parseInt(match[1]!, 10) : undefined;
}

function parsePrismaCall(code: string): ParsedQuery {
  // Match: prisma.modelName.method(
  const callRegex = /\bprisma\.(\w+)\.(\w+)\s*\(/;
  const callMatch = callRegex.exec(code);

  if (!callMatch) {
    throw new Error("Could not parse Prisma call. Expected format: prisma.model.method(...)");
  }

  const model = callMatch[1]!;
  const method = callMatch[2]!;

  // Extract the options object content
  const optionsStart = callMatch.index + callMatch[0].length - 1; // position of '('
  const braceStart = code.indexOf("{", optionsStart);

  const parsed: ParsedQuery = { model, method };

  if (braceStart >= 0) {
    const content = extractBraceContent(code, braceStart);
    if (content) {
      // where
      const whereIdx = content.indexOf("where:");
      if (whereIdx >= 0) {
        const whereContent = extractBraceContent(content, whereIdx);
        if (whereContent) {
          parsed.where = extractFields(whereContent);
        }
      }

      parsed.select = extractSelectedFields(content, "select");
      parsed.include = extractSelectedFields(content, "include");
      parsed.orderBy = extractOrderBy(content);
      parsed.take = extractNumericField(content, "take");
      parsed.skip = extractNumericField(content, "skip");
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function quoteIdentifier(name: string, dialect: Dialect): string {
  switch (dialect) {
    case "postgresql": return `"${name}"`;
    case "mysql": return `\`${name}\``;
    case "sqlite": return `"${name}"`;
  }
}

function modelToTable(model: string, dialect: Dialect): string {
  // Prisma convention: model User → table "User" (postgres) or `User` (mysql)
  return quoteIdentifier(model, dialect);
}

function whereToSql(where: Record<string, unknown>, dialect: Dialect): string {
  const conditions: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    const col = quoteIdentifier(key, dialect);
    if (typeof value === "string") {
      conditions.push(`${col} = '${value}'`);
    } else if (typeof value === "number") {
      conditions.push(`${col} = ${value}`);
    } else {
      conditions.push(`${col} = ?`);
    }
  }
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

function generateSql(parsed: ParsedQuery, dialect: Dialect): string {
  const table = modelToTable(parsed.model, dialect);

  const selectCols = parsed.select
    ? parsed.select.map((f) => quoteIdentifier(f, dialect)).join(", ")
    : "*";

  const whereSql = parsed.where ? whereToSql(parsed.where, dialect) : "";
  const orderSql = parsed.orderBy
    ? ` ORDER BY ${parsed.orderBy.map((o) => {
        const [field, dir] = o.split(" ");
        return `${quoteIdentifier(field!, dialect)} ${dir ?? "ASC"}`;
      }).join(", ")}`
    : "";

  switch (parsed.method) {
    case "findMany":
    case "findAll": {
      const limitSql = parsed.take != null ? ` LIMIT ${parsed.take}` : "";
      const offsetSql = parsed.skip != null ? ` OFFSET ${parsed.skip}` : "";
      return `SELECT ${selectCols} FROM ${table}${whereSql}${orderSql}${limitSql}${offsetSql}`;
    }
    case "findFirst": {
      return `SELECT ${selectCols} FROM ${table}${whereSql}${orderSql} LIMIT 1`;
    }
    case "findUnique": {
      return `SELECT ${selectCols} FROM ${table}${whereSql} LIMIT 1`;
    }
    case "count": {
      return `SELECT COUNT(*) FROM ${table}${whereSql}`;
    }
    case "aggregate": {
      return `SELECT COUNT(*), MIN(*), MAX(*), AVG(*), SUM(*) FROM ${table}${whereSql}`;
    }
    case "groupBy": {
      const groupCols = parsed.select
        ? parsed.select.map((f) => quoteIdentifier(f, dialect)).join(", ")
        : "?";
      return `SELECT ${groupCols}, COUNT(*) FROM ${table}${whereSql} GROUP BY ${groupCols}${orderSql}`;
    }
    case "create": {
      return `INSERT INTO ${table} (...) VALUES (...)`;
    }
    case "update": {
      return `UPDATE ${table} SET ...${whereSql}`;
    }
    case "delete":
    case "deleteMany": {
      return `DELETE FROM ${table}${whereSql}`;
    }
    default: {
      return `SELECT ${selectCols} FROM ${table}${whereSql}${orderSql}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Warnings and hints
// ---------------------------------------------------------------------------

function generateWarnings(parsed: ParsedQuery): string[] {
  const warnings: string[] = [];

  if ((parsed.method === "findMany" || parsed.method === "findAll") && parsed.take == null) {
    warnings.push("findMany without take — unbounded query, could return entire table");
  }

  if (parsed.include && parsed.include.length > 0) {
    warnings.push(`include with ${parsed.include.length} relation(s) — each generates a JOIN or sub-query`);
    if (parsed.include.length >= 3) {
      warnings.push("3+ includes — consider splitting into separate queries or using select");
    }
  }

  if (parsed.method === "deleteMany" && !parsed.where) {
    warnings.push("deleteMany without where — will delete ALL rows in table");
  }

  return warnings;
}

function generateHints(parsed: ParsedQuery): string[] {
  const hints: string[] = [];

  if ((parsed.method === "findMany" || parsed.method === "findAll") && parsed.take == null) {
    hints.push("Add take: 100 (or appropriate page size) for pagination");
  }

  if (parsed.where) {
    const nonIndexedCandidates = Object.keys(parsed.where).filter(
      (k) => !["id", "uuid", "email", "slug", "username"].includes(k.toLowerCase()),
    );
    for (const field of nonIndexedCandidates) {
      hints.push(`Consider adding an index on "${field}" if queried frequently`);
    }
  }

  if (parsed.orderBy && parsed.orderBy.length > 0) {
    for (const order of parsed.orderBy) {
      const field = order.split(" ")[0]!;
      hints.push(`Ensure index covers "${field}" for efficient ORDER BY`);
    }
  }

  if (parsed.skip != null && parsed.skip > 1000) {
    hints.push(`skip: ${parsed.skip} is expensive — consider cursor-based pagination instead`);
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function explainQuery(
  code: string,
  options?: { dialect?: Dialect },
): ExplainQueryResult {
  const dialect = options?.dialect ?? "postgresql";
  const parsed = parsePrismaCall(code);
  const sql = generateSql(parsed, dialect);

  return {
    sql,
    explain_command: `EXPLAIN ANALYZE ${sql}`,
    warnings: generateWarnings(parsed),
    optimization_hints: generateHints(parsed),
    parsed,
  };
}
