import { describe, it, expect } from "vitest";
import { chunkBySymbols, chunkFile } from "../../src/search/chunker.js";

describe("chunkBySymbols", () => {
  it("creates one chunk per symbol", () => {
    const source =
      "import x from 'y';\n\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    const symbols = [
      { name: "a", start_line: 3, end_line: 5 },
      { name: "b", start_line: 7, end_line: 9 },
    ];
    const chunks = chunkBySymbols("test.ts", source, "repo", symbols);
    expect(chunks.length).toBe(3); // preamble + a + b
    expect(chunks[0]!.startLine).toBe(1); // preamble
    expect(chunks[1]!.startLine).toBe(3); // function a
    expect(chunks[2]!.startLine).toBe(7); // function b
  });

  it("falls back to chunkFile when no symbols", () => {
    const source = "a\nb\nc\n";
    const chunks = chunkBySymbols("test.ts", source, "repo", []);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("skips preamble chunk when first symbol starts on line 1", () => {
    const source = "function a() {\n  return 1;\n}\n";
    const symbols = [{ name: "a", start_line: 1, end_line: 3 }];
    const chunks = chunkBySymbols("test.ts", source, "repo", symbols);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.startLine).toBe(1);
  });

  it("assigns correct chunk ids with repo:file:line format", () => {
    const source = "import x from 'y';\n\nfunction a() {\n  return 1;\n}\n";
    const symbols = [{ name: "a", start_line: 3, end_line: 5 }];
    const chunks = chunkBySymbols("test.ts", source, "myrepo", symbols);
    expect(chunks[0]!.id).toBe("myrepo:test.ts:1"); // preamble
    expect(chunks[1]!.id).toBe("myrepo:test.ts:3"); // function a
  });

  it("skips empty symbol bodies", () => {
    const source = "import x from 'y';\n\n\n\nfunction b() {\n  return 2;\n}\n";
    const symbols = [
      { name: "empty", start_line: 3, end_line: 3 }, // blank line
      { name: "b", start_line: 5, end_line: 7 },
    ];
    const chunks = chunkBySymbols("test.ts", source, "repo", symbols);
    // preamble + b (empty symbol body skipped)
    const names = chunks.map((c) => `${c.startLine}`);
    expect(chunks.some((c) => c.startLine === 5)).toBe(true);
  });

  it("computes tokenCount as ceil(text.length / 4)", () => {
    const source = "import x from 'y';\n\nfunction a() {\n  return 1;\n}\n";
    const symbols = [{ name: "a", start_line: 3, end_line: 5 }];
    const chunks = chunkBySymbols("test.ts", source, "repo", symbols);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.text.length / 4));
    }
  });
});
