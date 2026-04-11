import { describe, it, expect } from "vitest";
import { buildH11Hint } from "../../src/register-tools.js";
import { STUB_LANGUAGES, languageHasParser } from "../../src/parser/parser-manager.js";

describe("STUB_LANGUAGES", () => {
  it("contains text_stub and config (the two language strings without symbol extractors)", () => {
    expect(STUB_LANGUAGES.has("text_stub")).toBe(true);
    expect(STUB_LANGUAGES.has("config")).toBe(true);
  });

  it("does NOT contain kotlin — kotlin has a full tree-sitter extractor now", () => {
    expect(STUB_LANGUAGES.has("kotlin")).toBe(false);
  });

  it("does NOT contain any language that has a dedicated extractor", () => {
    for (const lang of [
      "typescript", "tsx", "javascript", "python", "go", "rust",
      "java", "ruby", "php", "markdown", "prisma", "astro",
      "conversation", "css", "kotlin",
    ]) {
      expect(STUB_LANGUAGES.has(lang)).toBe(false);
    }
  });
});

describe("languageHasParser", () => {
  it("returns true for kotlin", () => {
    expect(languageHasParser("kotlin")).toBe(true);
  });

  it("returns true for typescript", () => {
    expect(languageHasParser("typescript")).toBe(true);
  });

  it("returns false for text_stub", () => {
    expect(languageHasParser("text_stub")).toBe(false);
  });

  it("returns false for config", () => {
    expect(languageHasParser("config")).toBe(false);
  });
});

describe("buildH11Hint", () => {
  it("returns null for an empty file list", () => {
    expect(buildH11Hint([])).toBeNull();
  });

  it("returns null when no files are stub-language", () => {
    const files = [
      { path: "src/a.kt", language: "kotlin" },
      { path: "src/b.ts", language: "typescript" },
    ];
    expect(buildH11Hint(files)).toBeNull();
  });

  it("returns null when stub-language files are less than 30% of the repo", () => {
    const files = [
      { path: "a.swift", language: "text_stub" },
      { path: "a.ts", language: "typescript" },
      { path: "b.ts", language: "typescript" },
      { path: "c.ts", language: "typescript" },
      { path: "d.ts", language: "typescript" },
    ];
    expect(buildH11Hint(files)).toBeNull();
  });

  it("returns a hint when stub-language files dominate", () => {
    const files = [
      { path: "a.swift", language: "text_stub" },
      { path: "b.swift", language: "text_stub" },
      { path: "c.swift", language: "text_stub" },
      { path: "d.ts", language: "typescript" },
    ];
    const hint = buildH11Hint(files);
    expect(hint).not.toBeNull();
    expect(hint).toContain("⚡H11");
    expect(hint).toContain(".swift");
    expect(hint).toContain("75%");
  });

  it("does NOT count kotlin files as stubs — kotlin has a parser", () => {
    const files = [
      { path: "a.kt", language: "kotlin" },
      { path: "b.kt", language: "kotlin" },
      { path: "c.kt", language: "kotlin" },
      { path: "d.kt", language: "kotlin" },
    ];
    // A 100% Kotlin repo should never trigger H11.
    expect(buildH11Hint(files)).toBeNull();
  });

  it("mixed Kotlin + Swift repo fires H11 only for Swift portion", () => {
    const files = [
      { path: "a.swift", language: "text_stub" },
      { path: "b.swift", language: "text_stub" },
      { path: "c.kt", language: "kotlin" },
      { path: "d.kt", language: "kotlin" },
    ];
    const hint = buildH11Hint(files);
    expect(hint).not.toBeNull();
    expect(hint).toContain(".swift");
    expect(hint).not.toContain(".kt");
    expect(hint).toContain("50%");
  });

  it("lists up to 3 stub extensions", () => {
    const files = [
      { path: "a.swift", language: "text_stub" },
      { path: "b.dart", language: "text_stub" },
      { path: "c.scala", language: "text_stub" },
      { path: "d.zig", language: "text_stub" },
    ];
    const hint = buildH11Hint(files);
    expect(hint).not.toBeNull();
    // .zig should be dropped because only 3 extensions are listed
    const extMatches = (hint!.match(/\.\w+/g) ?? []).filter((s) =>
      [".swift", ".dart", ".scala", ".zig"].includes(s),
    );
    expect(extMatches).toHaveLength(3);
  });
});
