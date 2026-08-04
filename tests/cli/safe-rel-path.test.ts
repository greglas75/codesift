import { describe, it, expect } from "vitest";
import { safeRelPath } from "../../src/cli/hooks/pre-tool-use.js";

/**
 * This path is echoed back into hook output, so a filename is untrusted input on its way to a
 * terminal. The escape-injection claim in the source comment holds only if the strip covers the C1
 * block as well as C0 — an earlier version stopped at DEL and promised more than it delivered.
 */
describe("safeRelPath", () => {
  it("keeps the last three segments and normalises separators", () => {
    expect(safeRelPath("/a/b/c/d/e.ts")).toBe("c/d/e.ts");
    expect(safeRelPath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });

  it("strips C0 control characters and DEL", () => {
    for (const cp of [0x00, 0x07, 0x1b, 0x1f, 0x7f]) {
      const ch = String.fromCharCode(cp);
      expect(safeRelPath(`x/y/a${ch}b.ts`)).not.toContain(ch);
    }
    expect(safeRelPath(`x/y/a[31mb.ts`)).toBe("x/y/a?[31mb.ts");
  });

  it("strips C1 too — U+009B is CSI, which a Latin-1-decoding terminal acts on like ESC[", () => {
    expect(safeRelPath("x/y/a31mb.ts")).toBe("x/y/a?31mb.ts");
    for (const cp of [0x80, 0x85, 0x9b, 0x9f]) {
      const ch = String.fromCharCode(cp);
      expect(safeRelPath(`x/y/z${ch}.ts`)).not.toContain(ch);
    }
  });

  it("leaves ordinary non-ASCII alone — this strips control codes, not language", () => {
    expect(safeRelPath("src/日本語/файл.ts")).toBe(
      "src/日本語/файл.ts",
    );
  });
});
