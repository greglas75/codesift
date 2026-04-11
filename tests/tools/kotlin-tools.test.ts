import { describe, it, expect, vi, beforeEach } from "vitest";
import { findExtensionFunctions, analyzeSealedHierarchy } from "../../src/tools/kotlin-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

// Mock getCodeIndex
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

const { getCodeIndex } = await import("../../src/tools/index-tools.js");

function makeSymbol(overrides: Partial<CodeSymbol>): CodeSymbol {
  return {
    id: `test:${overrides.file ?? "test.kt"}:${overrides.name ?? "sym"}:${overrides.start_line ?? 1}`,
    repo: "test",
    name: overrides.name ?? "sym",
    kind: overrides.kind ?? "function",
    file: overrides.file ?? "test.kt",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 10,
    tokens: [],
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[], files?: Array<{ path: string }>): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    files: files ?? symbols
      .map((s) => s.file)
      .filter((f, i, a) => a.indexOf(f) === i)
      .map((path) => ({ path, language: "kotlin", symbol_count: 0, last_modified: 0, mtime_ms: 0 })),
    symbols,
  };
}

// ---------------------------------------------------------------------------
// find_extension_functions
// ---------------------------------------------------------------------------

describe("findExtensionFunctions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds extension functions matching receiver type", async () => {
    const index = makeIndex([
      makeSymbol({ name: "toSlug", kind: "function", signature: "String.()", file: "utils.kt", start_line: 1 }),
      makeSymbol({ name: "capitalize", kind: "function", signature: "String.(): String", file: "utils.kt", start_line: 5 }),
      makeSymbol({ name: "first", kind: "function", signature: "List<T>.(): T", file: "collections.kt", start_line: 1 }),
      makeSymbol({ name: "greet", kind: "function", signature: "(name: String): String", file: "service.kt", start_line: 1 }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.receiver_type).toBe("String");
    expect(result.total).toBe(2);
    expect(result.extensions.map((e) => e.name).sort()).toEqual(["capitalize", "toSlug"]);
  });

  it("does not match non-extension functions", async () => {
    const index = makeIndex([
      makeSymbol({ name: "greet", kind: "function", signature: "(name: String): String" }),
      makeSymbol({ name: "process", kind: "method", signature: "(data: List<String>): Unit" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.total).toBe(0);
  });

  it("matches generic receiver types", async () => {
    const index = makeIndex([
      makeSymbol({ name: "firstOrNull", kind: "function", signature: "List<T>.(): T?" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "List");
    expect(result.total).toBe(1);
    expect(result.extensions[0]!.name).toBe("firstOrNull");
  });

  it("handles suspend extension functions", async () => {
    const index = makeIndex([
      makeSymbol({ name: "fetchAsync", kind: "function", signature: "suspend String.(): Data" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String");
    expect(result.total).toBe(1);
  });

  it("filters by file_pattern", async () => {
    const index = makeIndex([
      makeSymbol({ name: "ext1", kind: "function", signature: "String.()", file: "src/utils.kt" }),
      makeSymbol({ name: "ext2", kind: "function", signature: "String.()", file: "test/utils.kt" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "String", { file_pattern: "src/" });
    expect(result.total).toBe(1);
    expect(result.extensions[0]!.name).toBe("ext1");
  });

  it("returns empty for unknown type", async () => {
    const index = makeIndex([
      makeSymbol({ name: "ext", kind: "function", signature: "String.()" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await findExtensionFunctions("test", "UnknownType");
    expect(result.total).toBe(0);
    expect(result.extensions).toEqual([]);
  });

  it("throws for unknown repo", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);
    await expect(findExtensionFunctions("missing", "String")).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// analyze_sealed_hierarchy
// ---------------------------------------------------------------------------

describe("analyzeSealedHierarchy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds subtypes of a sealed class", async () => {
    const index = makeIndex(
      [
        makeSymbol({
          name: "Result",
          kind: "class",
          file: "result.kt",
          source: "sealed class Result",
        }),
        makeSymbol({
          name: "Success",
          kind: "class",
          file: "result.kt",
          start_line: 3,
          source: "data class Success(val data: String) : Result()",
        }),
        makeSymbol({
          name: "Error",
          kind: "class",
          file: "result.kt",
          start_line: 5,
          source: "data class Error(val message: String) : Result()",
        }),
        makeSymbol({
          name: "Unrelated",
          kind: "class",
          file: "other.kt",
          source: "class Unrelated",
        }),
      ],
      // No .kt files in file list → when block scan is skipped (no files to read)
      [],
    );
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeSealedHierarchy("test", "Result");
    expect(result.sealed_class.name).toBe("Result");
    expect(result.total_subtypes).toBe(2);
    expect(result.subtypes.map((s) => s.name).sort()).toEqual(["Error", "Success"]);
    expect(result.when_blocks).toHaveLength(0);
  });

  it("throws for non-sealed class", async () => {
    const index = makeIndex([
      makeSymbol({ name: "Foo", kind: "class", source: "class Foo" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    await expect(analyzeSealedHierarchy("test", "NotFound")).rejects.toThrow("not found");
  });

  it("throws for unknown repo", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(null);
    await expect(analyzeSealedHierarchy("missing", "Result")).rejects.toThrow("not found");
  });
});
