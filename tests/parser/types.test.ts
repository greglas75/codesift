import { describe, it, expect } from "vitest";
import type { SymbolKind, CodeSymbol } from "../../src/types.js";

describe("SymbolKind SQL additions", () => {
  it("accepts table kind", () => {
    const sym: CodeSymbol = {
      id: "repo:file.sql:orders:1",
      repo: "repo",
      name: "orders",
      kind: "table",
      file: "file.sql",
      start_line: 1,
      end_line: 5,
    };
    expect(sym.kind).toBe("table");
  });

  it("accepts view kind", () => {
    const kind: SymbolKind = "view";
    expect(kind).toBe("view");
  });

  it("accepts index kind", () => {
    const kind: SymbolKind = "index";
    expect(kind).toBe("index");
  });

  it("accepts trigger kind", () => {
    const kind: SymbolKind = "trigger";
    expect(kind).toBe("trigger");
  });

  it("accepts procedure kind", () => {
    const kind: SymbolKind = "procedure";
    expect(kind).toBe("procedure");
  });
});
