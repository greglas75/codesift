import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSymbolPosition } from "../../src/lsp/lsp-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

/**
 * resolveSymbolPosition used to return character:0 — the start of the line — so
 * for `export function foo(...)` it pointed at the `export` keyword. LSP hover /
 * definition / type only respond ON the identifier token, so every LSP-backed
 * call (getTypeInfo, goToDefinition, getCallHierarchy) silently returned "no
 * hover info at this position". It must aim at the symbol name's column.
 */
describe("resolveSymbolPosition — lands on the identifier, not column 0", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codesift-lsp-pos-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function idx(file: string, contents: string, sym: Partial<CodeSymbol>): CodeIndex {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, file), contents);
    return {
      root: dir,
      symbols: [{ name: sym.name!, file, start_line: sym.start_line!, kind: "function" } as CodeSymbol],
    } as CodeIndex;
  }

  it("points at the identifier column on an exported declaration", async () => {
    const index = idx("src/a.ts", "export function myFunc(a: number) {\n  return a;\n}\n", { name: "myFunc", start_line: 1 });
    const pos = await resolveSymbolPosition(index, "myFunc");
    expect(pos).not.toBeNull();
    // "export function " is 16 chars, so `myFunc` starts at column 16 — NOT 0.
    expect(pos!.character).toBe("export function ".length);
    expect(pos!.line).toBe(0);
  });

  it("does not match a substring inside a longer identifier", async () => {
    // `foo` must not resolve to the `foo` inside `fooBar`.
    const index = idx("src/b.ts", "const fooBar = 1;\nconst foo = 2;\n", { name: "foo", start_line: 2 });
    const pos = await resolveSymbolPosition(index, "foo");
    expect(pos!.character).toBe("const ".length); // line 2, `foo` at col 6
  });

  it("falls back to column 0 when the file cannot be read", async () => {
    const index = { root: dir, symbols: [{ name: "ghost", file: "src/missing.ts", start_line: 1, kind: "function" } as CodeSymbol] } as CodeIndex;
    const pos = await resolveSymbolPosition(index, "ghost");
    expect(pos).toEqual({ filePath: "src/missing.ts", line: 0, character: 0 });
  });

  it("honours an explicit position without touching disk", async () => {
    const index = { root: dir, symbols: [] } as unknown as CodeIndex;
    const pos = await resolveSymbolPosition(index, "x", "src/x.ts", 5, 9);
    expect(pos).toEqual({ filePath: "src/x.ts", line: 5, character: 9 });
  });
});
