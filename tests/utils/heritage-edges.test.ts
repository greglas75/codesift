import { describe, it, expect } from "vitest";
import { collectHeritageFileEdges } from "../../src/utils/heritage-edges.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

function minimalIndex(repo: string, symbols: CodeSymbol[]): CodeIndex {
  const files = [...new Set(symbols.map((s) => s.file))].map((path) => ({
    path,
    language: "typescript",
    symbol_count: symbols.filter((s) => s.file === path).length,
    last_modified: 0,
  }));
  return {
    repo,
    root: "/tmp",
    symbols,
    files,
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

function sym(partial: Omit<CodeSymbol, "id" | "repo" | "start_line" | "end_line"> & { id?: string }): CodeSymbol {
  const start_line = 1;
  const end_line = 2;
  return {
    id: partial.id ?? `r:${partial.file}:${partial.name}:${start_line}`,
    repo: partial.repo ?? "r",
    start_line,
    end_line,
    ...partial,
  };
}

describe("collectHeritageFileEdges", () => {
  it("adds an implements edge when the interface name resolves uniquely", () => {
    const symbols: CodeSymbol[] = [
      sym({ file: "a.ts", name: "I", kind: "interface", repo: "r" }),
      sym({ file: "b.ts", name: "C", kind: "class", repo: "r", implements: ["I"] }),
    ];
    const edges = collectHeritageFileEdges(minimalIndex("r", symbols));
    expect(edges).toEqual([{ from: "b.ts", to: "a.ts", kind: "implements" }]);
  });

  it("skips ambiguous type names (multiple declarations)", () => {
    const symbols: CodeSymbol[] = [
      sym({ file: "a.ts", name: "Props", kind: "interface", repo: "r" }),
      sym({ file: "b.ts", name: "Props", kind: "interface", repo: "r" }),
      sym({ file: "c.ts", name: "X", kind: "class", repo: "r", implements: ["Props"] }),
    ];
    expect(collectHeritageFileEdges(minimalIndex("r", symbols))).toHaveLength(0);
  });

  it("adds extends edge for unique superclass", () => {
    const symbols: CodeSymbol[] = [
      sym({ file: "base.ts", name: "Base", kind: "class", repo: "r" }),
      sym({ file: "child.ts", name: "Child", kind: "class", repo: "r", extends: ["Base"] }),
    ];
    const edges = collectHeritageFileEdges(minimalIndex("r", symbols));
    expect(edges).toEqual([{ from: "child.ts", to: "base.ts", kind: "extends" }]);
  });
});
