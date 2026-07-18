import { describe, it, expect } from "vitest";
import { stripCommentsAndStrings } from "../../src/utils/source-stripper.js";

describe("stripCommentsAndStrings — basic states", () => {
  it("strips // line comments to whitespace", () => {
    const input = "const x = 1; // this is a comment\nconst y = 2;";
    const result = stripCommentsAndStrings(input);
    expect(result).toBe("const x = 1;                     \nconst y = 2;");
  });

  it("strips /* block comments */ preserving newlines", () => {
    const input = "a;\n/* multi\n  line */\nb;";
    const result = stripCommentsAndStrings(input);
    expect(result).toBe("a;\n        \n         \nb;");
  });

  it("strips single-quoted strings", () => {
    const input = "const a = 'hello world'; const b = 1;";
    expect(stripCommentsAndStrings(input)).toBe("const a =              ; const b = 1;");
  });

  it("strips double-quoted strings", () => {
    const input = `const a = "hello"; const b = 1;`;
    expect(stripCommentsAndStrings(input)).toBe("const a =        ; const b = 1;");
  });

  it("strips template literals (no interpolation)", () => {
    const input = "const a = `hello`;";
    expect(stripCommentsAndStrings(input)).toBe("const a =        ;");
  });
});

describe("stripCommentsAndStrings — interaction edge cases", () => {
  it("// inside a string is NOT a comment", () => {
    const input = `const url = "https://example.com//path"; const x = 1;`;
    const result = stripCommentsAndStrings(input);
    // The string is whitespace-replaced; whatever follows is preserved code.
    expect(result.includes("const x = 1;")).toBe(true);
    // The // inside the string is gone (replaced with whitespace)
    expect(result.includes("//")).toBe(false);
  });

  it("/* inside a string is NOT a block comment", () => {
    const input = `const x = "/* not a comment */"; const y = 2;`;
    const result = stripCommentsAndStrings(input);
    expect(result.includes("const y = 2;")).toBe(true);
    // No leftover */
    expect(result.includes("*/")).toBe(false);
  });

  it("escaped quote inside string does not terminate the string", () => {
    const input = `const a = "she said \\"hi\\""; const b = 2;`;
    const result = stripCommentsAndStrings(input);
    expect(result.includes("const b = 2;")).toBe(true);
  });

  it("regex literal /pattern/ is stripped (not parsed as division)", () => {
    const input = "const r = /https:\\/\\/x/; const y = 1;";
    const result = stripCommentsAndStrings(input);
    // The /https:\/\/x/ should be gone, just whitespace
    expect(result.includes("https")).toBe(false);
    expect(result.includes("const y = 1;")).toBe(true);
  });

  it("regex literal with character class /[a/b]/ handles internal /", () => {
    const input = "const r = /[a/b]+/; const y = 1;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("const y = 1;")).toBe(true);
  });

  it("`/` after identifier is treated as division, not regex", () => {
    // After `x` (an identifier), `/` is division. So `// foo` here looks like
    // line comment? No — actually `/` after identifier is division per spec.
    // We keep `x / y` as `x / y` (division operator preserved as code).
    const input = "const a = x / y;";
    const result = stripCommentsAndStrings(input);
    expect(result).toBe("const a = x / y;");
  });

  it("preserves compound division assignment", () => {
    const input = "let x = 8; x /= 2; const y = 1;";
    expect(stripCommentsAndStrings(input)).toBe(input);
  });

  it("strips regex immediately after a keyword", () => {
    const input = "const x = typeof/foo/.test(value); const y = 1;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("foo")).toBe(false);
    expect(result.includes("const y = 1;")).toBe(true);
  });
});

describe("stripCommentsAndStrings — preserves character positions", () => {
  it("output length equals input length", () => {
    const cases = [
      "const x = 1;",
      "// comment\ncode;",
      "/* a */ b;",
      `"hello" world;`,
      "/regex/ foo;",
    ];
    for (const c of cases) {
      expect(stripCommentsAndStrings(c).length).toBe(c.length);
    }
  });

  it("preserves newlines (line numbers stay correct)", () => {
    const input = "line1\n// line2 comment\nline3";
    const result = stripCommentsAndStrings(input);
    expect(result.split("\n").length).toBe(3);
  });
});

describe("stripCommentsAndStrings — Suspense detection scenarios", () => {
  it("removes <Suspense> mention from a comment", () => {
    const input = "// example: <Suspense>...</Suspense>\nfunction X() {}";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("<Suspense")).toBe(false);
  });

  it("removes <Suspense> mention from a string literal", () => {
    const input = `const docs = "use <Suspense>"; function X() {}`;
    const result = stripCommentsAndStrings(input);
    expect(result.includes("<Suspense")).toBe(false);
  });

  it("preserves real <Suspense> JSX", () => {
    const input = `function Root() { return <Suspense fallback={<L/>}><App/></Suspense>; }`;
    const result = stripCommentsAndStrings(input);
    expect(result.includes("<Suspense")).toBe(true);
  });
});

describe("stripCommentsAndStrings — adversarial Run-1 fixes", () => {
  it("preserves regex after `return` keyword (was: misclassified as division)", () => {
    const input = "function f() { return /foo|bar/g; }";
    const result = stripCommentsAndStrings(input);
    // Regex content should be stripped to whitespace
    expect(result.includes("foo|bar")).toBe(false);
    // Trailing flag `g` should also be stripped
    expect(result).toBe("function f() { return           ; }");
  });

  it("preserves regex after `throw` keyword", () => {
    const input = "throw /msg/;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("msg")).toBe(false);
  });

  it("preserves regex after `case` keyword", () => {
    const input = "case /pattern/:";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("pattern")).toBe(false);
  });

  it("strips trailing regex flags (gimsuy) so they don't leak as code", () => {
    const input = "const r = /x/gimsy;";
    const result = stripCommentsAndStrings(input);
    // Output should be code-equivalent without leftover flag chars
    expect(result.includes("gimsy")).toBe(false);
    // `const r =` and `;` preserved
    expect(result.includes("const r =")).toBe(true);
    expect(result.includes(";")).toBe(true);
  });

  it("strips the unicode sets regex flag v", () => {
    const input = "const r = /[\\p{ASCII}]/v; const y = 1;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("ASCII")).toBe(false);
    expect(result.includes("const y = 1;")).toBe(true);
  });

  it("template literal ${expr} expression preserves code inside", () => {
    // Adversarial Run 1: ${...} contents were stripped opaque, hiding code.
    // Now ${} content is processed as code, so console.log inside is detected.
    const input = "const x = `hello ${console.log('hi')} world`;";
    const result = stripCommentsAndStrings(input);
    // The console.log identifier should remain in code stream
    expect(result.includes("console.log")).toBe(true);
  });

  it("nested ${} interpolation handled (depth tracking)", () => {
    const input = "const x = `a ${ `b ${ c } d` } e`;";
    // Should round-trip without breaking — code positions preserved
    expect(stripCommentsAndStrings(input).length).toBe(input.length);
  });

  it("resumes template stripping after interpolation closes", () => {
    const input = "const x = `before ${value} // hidden`; const y = 1;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("hidden")).toBe(false);
    expect(result.includes("const y = 1;")).toBe(true);
  });

  it("keeps template mode across multiple interpolations with braces", () => {
    const input = "const x = `a ${fn({value: 1})} b ${other} // hidden`; const y = 1;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("hidden")).toBe(false);
    expect(result.includes("const y = 1;")).toBe(true);
  });

  it("template literal with no interpolation still strips contents", () => {
    const input = "const x = `hello world`;";
    const result = stripCommentsAndStrings(input);
    expect(result.includes("hello")).toBe(false);
    expect(result.includes("world")).toBe(false);
  });
});
