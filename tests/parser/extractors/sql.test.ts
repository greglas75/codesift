import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Will fail until the extractor is created
import { extractSqlSymbols } from "../../../src/parser/extractors/sql.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures/sql");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

describe("extractSqlSymbols", () => {
  describe("basic CREATE TABLE", () => {
    it("extracts table name and kind", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const tables = symbols.filter((s) => s.kind === "table");
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe("orders");
      expect(tables[0]!.kind).toBe("table");
    });

    it("computes correct start_line (1-based)", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const table = symbols.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      expect(table!.start_line).toBe(2); // line 1 is comment, line 2 is CREATE TABLE
    });

    it("computes end_line at closing paren/semicolon", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const table = symbols.find((s) => s.kind === "table");
      expect(table!.end_line).toBeGreaterThanOrEqual(6);
    });

    it("generates a valid symbol id", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "schema.sql", "local/myapp");

      const table = symbols.find((s) => s.kind === "table");
      expect(table!.id).toBe("local/myapp:schema.sql:orders:2");
    });

    it("includes source text", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const table = symbols.find((s) => s.kind === "table");
      expect(table!.source).toContain("CREATE TABLE orders");
    });

    it("extracts preceding comment as docstring", () => {
      const source = loadFixture("basic-table.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const table = symbols.find((s) => s.kind === "table");
      expect(table!.docstring).toContain("Basic table for testing");
    });
  });
});
