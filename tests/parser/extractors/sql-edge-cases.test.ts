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

  it("syntax errors → extracts valid DDL around errors, does not throw", () => {
    const symbols = extractSqlSymbols(load("syntax-error.sql"), "error.sql", "repo");
    // Should find the two valid tables, skip the broken one
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.name)).toEqual(["valid_table", "another_valid"]);
  });
});
