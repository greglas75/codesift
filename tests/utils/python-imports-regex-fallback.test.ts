// When the tree-sitter parse fails, Python used to lose EVERY import edge in the file: the
// collector logged a warning and returned, and nothing downstream knew the graph was incomplete.
// TypeScript had had a regex fallback since it was written.
//
// Measured on this machine 2026-08-19: 30 failures, all `memory access out of bounds` from an
// exhausted WASM heap, across a reporting module and its tests — files whose edges simply stopped
// existing for find_circular_deps, detect_communities, impact_analysis and check_boundaries.
import { describe, it, expect } from "vitest";
import { extractPythonImportsByRegex } from "../../src/utils/python-imports.js";

const modules = (src: string) => extractPythonImportsByRegex(src).map((i) => `${".".repeat(i.level)}${i.module}`);

describe("extractPythonImportsByRegex", () => {
  it("reads plain and dotted imports", () => {
    expect(modules("import os\nimport a.b.c\n")).toEqual(["os", "a.b.c"]);
  });

  it("splits a comma-separated import and keeps the module, not the alias", () => {
    expect(modules("import a as x, b.c as y\n")).toEqual(["a", "b.c"]);
  });

  it("counts the dots on relative imports, which is what the resolver keys on", () => {
    expect(modules("from . import sibling\nfrom ..pkg.mod import thing\n")).toEqual([".", "..pkg.mod"]);
  });

  it("marks a star import", () => {
    const [imp] = extractPythonImportsByRegex("from pkg.mod import *\n");
    expect(imp?.is_star).toBe(true);
    expect(imp?.module).toBe("pkg.mod");
  });

  it("ignores comments", () => {
    expect(modules("# import commented_out\nimport real\n")).toEqual(["real"]);
  });

  it("does not treat a mid-line word as an import", () => {
    // `result = import_helper()` must not become an edge; anchoring at line start is what prevents it.
    expect(modules("result = import_helper()\nx = 1\n")).toEqual([]);
  });

  it("is honest about `is_type_only` rather than guessing", () => {
    // The AST knows about `if TYPE_CHECKING:` blocks; line-based matching cannot. Claiming
    // type-only here would drop a real runtime edge, so it always reports false — the direction
    // that keeps the graph too connected rather than too sparse.
    const [imp] = extractPythonImportsByRegex("if TYPE_CHECKING:\n    from pkg import Thing\n");
    expect(imp?.module).toBe("pkg");
    expect(imp?.is_type_only).toBe(false);
  });
});
