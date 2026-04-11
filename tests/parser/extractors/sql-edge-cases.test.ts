import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractSqlSymbols } from "../../../src/parser/extractors/sql.js";

const EDGE = join(import.meta.dirname, "../../fixtures/sql/edge-cases");

function load(name: string): string {
  return readFileSync(join(EDGE, name), "utf-8");
}

describe("SQL extractor edge cases", () => {
  it("empty file → no symbols, no crash", () => {
    const symbols = extractSqlSymbols(load("empty.sql"), "empty.sql", "repo");
    expect(symbols).toEqual([]);
  });

  it("comment-only file → no symbols", () => {
    const symbols = extractSqlSymbols(load("comment-only.sql"), "comment-only.sql", "repo");
    expect(symbols).toEqual([]);
  });

  it("multi-statement file → extracts all 5 tables", () => {
    const symbols = extractSqlSymbols(load("multi-statement.sql"), "multi.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(5);
    expect(tables.map((t) => t.name)).toEqual([
      "users", "orders", "line_items", "products", "categories",
    ]);
  });

  it("mixed DDL/DML → only DDL symbols extracted (no INSERT/SELECT/UPDATE/DELETE)", () => {
    const symbols = extractSqlSymbols(load("mixed-ddl-dml.sql"), "mixed.sql", "repo");
    const ddlKinds = symbols.filter((s) => s.kind === "table" || s.kind === "index");
    // 1 table + 1 index = 2 DDL symbols (plus columns as fields)
    expect(ddlKinds).toHaveLength(2);
    expect(ddlKinds[0]!.name).toBe("audit_log");
    expect(ddlKinds[1]!.name).toBe("idx_audit_action");

    // No DML symbols
    const allKinds = new Set(symbols.map((s) => s.kind));
    expect(allKinds).not.toContain("dml");
    expect(allKinds).not.toContain("unknown");
  });

  it("circular FK → both tables extracted without crash", () => {
    const symbols = extractSqlSymbols(load("circular-fk.sql"), "circular.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.name)).toEqual(["departments", "employees"]);
  });

  it("MySQL backtick-quoted identifiers with #__ prefix (Joomla)", () => {
    const symbols = extractSqlSymbols(load("mysql-backticks.sql"), "mysql.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables[0]!.name).toBe("#__action_log_config");
    expect(tables[1]!.name).toBe("#__users");

    // Backtick-quoted column names extracted
    const idFields = symbols.filter((s) => s.kind === "field" && s.name === "id");
    expect(idFields.length).toBeGreaterThanOrEqual(2);
  });

  it("minified single-line SQL with multiple statements", () => {
    const symbols = extractSqlSymbols(load("minified.sql"), "minified.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.name)).toEqual(["users", "orders"]);

    const indexes = symbols.filter((s) => s.kind === "index");
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.name).toBe("idx_user");

    // Columns extracted from minified table bodies
    const fields = symbols.filter((s) => s.kind === "field");
    expect(fields.length).toBeGreaterThanOrEqual(5); // 2 + 3 columns
  });

  it("semicolon inside string literal does not terminate view early", () => {
    const symbols = extractSqlSymbols(load("semicolon-in-string.sql"), "test.sql", "repo");
    const view = symbols.find((s) => s.kind === "view");
    expect(view).toBeDefined();
    expect(view!.name).toBe("greeting");
    // The view source should include the full SELECT with the semicolon in the string
    expect(view!.source).toContain("hello;world");

    // The table after the view should also be extracted
    const table = symbols.find((s) => s.kind === "table");
    expect(table).toBeDefined();
    expect(table!.name).toBe("after_view");
  });

  it("syntax errors → extracts valid DDL around errors, does not throw", () => {
    const symbols = extractSqlSymbols(load("syntax-error.sql"), "error.sql", "repo");
    // Should find the two valid tables, skip the broken one
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.name)).toEqual(["valid_table", "another_valid"]);
  });
});
