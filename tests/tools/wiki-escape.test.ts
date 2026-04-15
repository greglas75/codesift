import { describe, it, expect } from "vitest";
import { escMd, escHtml } from "../../src/tools/wiki-escape";

const INPUT = `a < b [c](d) *e* & "f"`;

describe("escMd", () => {
  it("escapes markdown-significant chars: [ ] ( ) < > * _ backtick", () => {
    const result = escMd(INPUT);
    expect(result).toContain("\\<");
    expect(result).toContain("\\[");
    expect(result).toContain("\\]");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
    expect(result).toContain("\\*");
    // backtick test
    expect(escMd("use `code`")).toContain("\\`");
    // underscore test
    expect(escMd("_italic_")).toContain("\\_");
  });

  it("handles empty string → returns empty string", () => {
    expect(escMd("")).toBe("");
  });

  it("does NOT produce HTML entities (outputs \\< not &lt;)", () => {
    const result = escMd(INPUT);
    expect(result).not.toContain("&lt;");
    expect(result).not.toContain("&gt;");
    expect(result).not.toContain("&amp;");
  });
});

describe("escHtml", () => {
  it("escapes HTML-significant chars: & < > \" '", () => {
    const result = escHtml(INPUT);
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&quot;");
    // > and ' tests with dedicated inputs
    expect(escHtml("a > b")).toContain("&gt;");
    expect(escHtml("it's")).toContain("&#39;");
  });

  it("handles empty string → returns empty string", () => {
    expect(escHtml("")).toBe("");
  });

  it("does NOT escape markdown-specific chars ([ ] * are unchanged)", () => {
    const result = escHtml(INPUT);
    expect(result).toContain("[");
    expect(result).toContain("]");
    expect(result).toContain("*");
  });
});
