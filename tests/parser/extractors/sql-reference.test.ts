import { describe, it, expect } from "vitest";
import { extractSqlSymbols } from "../../../src/parser/extractors/sql.js";

/**
 * Generate a reference schema with N tables, M views, K indexes.
 * Deterministic — same input → same output.
 */
function generateReferenceSchema(tables: number, views: number, indexes: number): string {
  const lines: string[] = ["-- Reference schema for SQL extractor validation"];

  for (let i = 1; i <= tables; i++) {
    const name = `table_${String(i).padStart(3, "0")}`;
    lines.push("");
    lines.push(`-- Table ${i} of ${tables}`);
    lines.push(`CREATE TABLE ${name} (`);
    lines.push(`  id INT PRIMARY KEY,`);
    lines.push(`  name VARCHAR(255),`);
    if (i > 1) {
      // FK to the previous table for relationship graph
      const prevName = `table_${String(i - 1).padStart(3, "0")}`;
      lines.push(`  parent_id INT REFERENCES ${prevName}(id),`);
    }
    lines.push(`  created_at TIMESTAMP DEFAULT NOW()`);
    lines.push(`);`);
  }

  for (let i = 1; i <= views; i++) {
    const sourceTable = `table_${String(i).padStart(3, "0")}`;
    const name = `view_${String(i).padStart(3, "0")}`;
    lines.push("");
    lines.push(`CREATE VIEW ${name} AS SELECT * FROM ${sourceTable} WHERE id > 0;`);
  }

  for (let i = 1; i <= indexes; i++) {
    const sourceTable = `table_${String(i).padStart(3, "0")}`;
    const name = `idx_${sourceTable}_name`;
    lines.push("");
    lines.push(`CREATE INDEX ${name} ON ${sourceTable}(name);`);
  }

  return lines.join("\n");
}

describe("SQL reference schema", () => {
  const TABLES = 50;
  const VIEWS = 10;
  const INDEXES = 20;
  const schema = generateReferenceSchema(TABLES, VIEWS, INDEXES);

  it(`extracts exactly ${TABLES} tables`, () => {
    const symbols = extractSqlSymbols(schema, "ref.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(TABLES);
  });

  it(`extracts exactly ${VIEWS} views`, () => {
    const symbols = extractSqlSymbols(schema, "ref.sql", "repo");
    const views = symbols.filter((s) => s.kind === "view");
    expect(views).toHaveLength(VIEWS);
  });

  it(`extracts exactly ${INDEXES} indexes`, () => {
    const symbols = extractSqlSymbols(schema, "ref.sql", "repo");
    const indexes = symbols.filter((s) => s.kind === "index");
    expect(indexes).toHaveLength(INDEXES);
  });

  it("table names are correct and ordered", () => {
    const symbols = extractSqlSymbols(schema, "ref.sql", "repo");
    const tableNames = symbols
      .filter((s) => s.kind === "table")
      .map((s) => s.name);
    const expected = Array.from({ length: TABLES }, (_, i) =>
      `table_${String(i + 1).padStart(3, "0")}`
    );
    expect(tableNames).toEqual(expected);
  });

  it("every table has column children (field symbols)", () => {
    const symbols = extractSqlSymbols(schema, "ref.sql", "repo");
    const tables = symbols.filter((s) => s.kind === "table");
    for (const table of tables) {
      const fields = symbols.filter((s) => s.kind === "field" && s.parent === table.id);
      expect(fields.length).toBeGreaterThanOrEqual(3); // id, name, created_at at minimum
    }
  });

  it("extraction completes in under 500ms for 80-symbol schema", () => {
    const start = performance.now();
    extractSqlSymbols(schema, "ref.sql", "repo");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
