import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Will fail until the extractor is created
import { extractSqlSymbols, stripJinjaTokens } from "../../../src/parser/extractors/sql.js";

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

  describe("column extraction as field children", () => {
    it("extracts columns as field symbols with parent reference", () => {
      const source = loadFixture("columns.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const table = symbols.find((s) => s.kind === "table");
      expect(table).toBeDefined();

      const fields = symbols.filter((s) => s.kind === "field");
      expect(fields).toHaveLength(3);
      expect(fields.map((f) => f.name)).toEqual(["id", "user_id", "total"]);

      // All fields point to parent table
      for (const field of fields) {
        expect(field.parent).toBe(table!.id);
      }
    });

    it("sets field signature to column type declaration", () => {
      const source = loadFixture("columns.sql");
      const symbols = extractSqlSymbols(source, "test.sql", "repo");

      const idField = symbols.find((s) => s.name === "id" && s.kind === "field");
      expect(idField!.signature).toContain("INT");

      const totalField = symbols.find((s) => s.name === "total" && s.kind === "field");
      expect(totalField!.signature).toContain("DECIMAL");
    });
  });

  describe("stripJinjaTokens", () => {
    it("replaces Jinja expressions with spaces preserving length", () => {
      const input = "SELECT {{ ref('x') }} FROM a";
      const output = stripJinjaTokens(input);
      // {{ ref('x') }} = 16 chars → 16 spaces
      expect(output.length).toBe(input.length);
      expect(output).not.toContain("{{");
      expect(output).not.toContain("}}");
      expect(output).toContain("SELECT ");
      expect(output).toContain(" FROM a");
    });

    it("preserves newlines inside Jinja blocks", () => {
      const input = "{% if x %}\nCREATE TABLE foo (id INT);\n{% endif %}";
      const output = stripJinjaTokens(input);
      expect(output).toContain("\nCREATE TABLE foo (id INT);\n");
      // Jinja markers replaced with spaces, newlines preserved
      expect(output.split("\n")).toHaveLength(3);
    });

    it("extracts table at correct line from Jinja-stripped source", () => {
      const source = loadFixture("jinja-model.sql");
      const stripped = stripJinjaTokens(source);
      const symbols = extractSqlSymbols(stripped, "model.sql", "repo", source);

      const table = symbols.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      expect(table!.name).toBe("derived_orders");
      expect(table!.start_line).toBe(7); // line 7 in the original
    });

    it("preserves original source in symbol source field", () => {
      const source = loadFixture("jinja-model.sql");
      const stripped = stripJinjaTokens(source);
      const symbols = extractSqlSymbols(stripped, "model.sql", "repo", source);

      const table = symbols.find((s) => s.kind === "table");
      // source field comes from originalSource, not stripped
      expect(table!.source).toContain("CREATE TABLE derived_orders");
    });
  });

  describe("all DDL constructs", () => {
    it("extracts exactly 11 symbols with correct kinds", () => {
      const source = loadFixture("all-ddl.sql");
      const symbols = extractSqlSymbols(source, "all.sql", "repo");

      const expected = [
        { name: "users", kind: "table" },
        { name: "id", kind: "field" },        // column child of users
        { name: "name", kind: "field" },       // column child of users
        { name: "active_users", kind: "view" },
        { name: "user_stats", kind: "view" },
        { name: "idx_users_name", kind: "index" },
        { name: "idx_users_email", kind: "index" },
        { name: "get_user_count", kind: "function" },
        { name: "update_user_status", kind: "procedure" },
        { name: "trg_users_updated", kind: "trigger" },
        { name: "inventory", kind: "namespace" },
        { name: "mood", kind: "type" },
        { name: "order_seq", kind: "variable" },
      ];

      expect(symbols.map((s) => ({ name: s.name, kind: s.kind }))).toEqual(expected);
    });
  });
});
