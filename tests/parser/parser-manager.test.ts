import { describe, it, expect } from "vitest";
import { getLanguageForExtension } from "../../src/parser/parser-manager.js";

describe("getLanguageForExtension", () => {
  describe("config file extensions", () => {
    const configExts = [".env", ".yaml", ".yml", ".toml", ".ini", ".properties", ".json"];

    for (const ext of configExts) {
      it(`returns "config" for ${ext}`, () => {
        expect(getLanguageForExtension(ext)).toBe("config");
      });
    }
  });

  it("returns null for unknown extensions", () => {
    expect(getLanguageForExtension(".xyz")).toBeNull();
  });

  it("returns typescript for .ts", () => {
    expect(getLanguageForExtension(".ts")).toBe("typescript");
  });

  it("returns markdown for .md", () => {
    expect(getLanguageForExtension(".md")).toBe("markdown");
  });

  it("returns conversation for .jsonl", () => {
    expect(getLanguageForExtension(".jsonl")).toBe("conversation");
  });

  it("returns kotlin for .kt", () => {
    expect(getLanguageForExtension(".kt")).toBe("kotlin");
  });

  it("returns kotlin for .kts", () => {
    expect(getLanguageForExtension(".kts")).toBe("kotlin");
  });

  it("returns sql for .sql", () => {
    expect(getLanguageForExtension(".sql")).toBe("sql");
  });
});
