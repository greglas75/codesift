import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractSymbolRefs, extractFilePaths, auditAgentConfig } from "../../src/tools/agent-config-tools.js";
import type { CodeIndex, FileEntry, CodeSymbol } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock getCodeIndex — I/O boundary (reads from storage)
// ---------------------------------------------------------------------------

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

// ---------------------------------------------------------------------------
// Mock fs/promises — I/O boundary (reads config files)
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(args[0] as string, args[1] as string),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(name: string): CodeSymbol {
  return {
    id: `test:src/main.ts:${name}:1`,
    repo: "test",
    name,
    kind: "function",
    file: "src/main.ts",
    start_line: 1,
    end_line: 10,
  };
}

function makeFile(path: string, language: string = "typescript"): FileEntry {
  return {
    path,
    language,
    symbol_count: 1,
    last_modified: Date.now(),
  };
}

function makeIndex(
  symbols: CodeSymbol[] = [],
  files: FileEntry[] = [],
): CodeIndex {
  const now = Date.now();
  return {
    repo: "test",
    root: "/test-repo",
    symbols,
    files,
    created_at: now,
    updated_at: now,
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

// ---------------------------------------------------------------------------
// Tests — extractors
// ---------------------------------------------------------------------------

describe("extractSymbolRefs", () => {
  it("extracts backtick-quoted identifiers (min 3 chars)", () => {
    const text = "Use `createUser` and `OrderService` to handle orders.";
    const result = extractSymbolRefs(text);
    expect(result).toEqual(["createUser", "OrderService"]);
  });

  it("ignores short identifiers (< 3 chars)", () => {
    const text = "The `a` variable and `xy` are too short, but `foo` is fine.";
    const result = extractSymbolRefs(text);
    expect(result).toEqual(["foo"]);
  });

  it("ignores operators and non-identifier content in backticks", () => {
    const text = "Check `a > b` and `x + y` but also `validName`.";
    const result = extractSymbolRefs(text);
    expect(result).toEqual(["validName"]);
  });
});

describe("extractFilePaths", () => {
  it("extracts file paths with known extensions", () => {
    const text = "See src/tools/foo.ts and lib/utils.py for details.";
    const result = extractFilePaths(text);
    expect(result).toEqual(["src/tools/foo.ts", "lib/utils.py"]);
  });

  it("ignores extensionless paths", () => {
    const text = "The src/tools/foo directory is important.";
    const result = extractFilePaths(text);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — auditAgentConfig
// ---------------------------------------------------------------------------

describe("auditAgentConfig", () => {
  beforeEach(() => {
    mockGetCodeIndex.mockReset();
    mockReadFile.mockReset();
  });

  it("detects stale symbols (symbol NOT in index)", async () => {
    const index = makeIndex(
      [makeSymbol("createUser")],
      [makeFile("src/main.ts")],
    );
    mockGetCodeIndex.mockResolvedValue(index);
    mockReadFile.mockResolvedValue("Use `createUser` and `deleteUser` here.");

    const result = await auditAgentConfig("test", { config_path: "/test-repo/CLAUDE.md" });

    expect(result.stale_symbols).toEqual([
      { symbol: "deleteUser", line: 1 },
    ]);
  });

  it("detects dead paths (path NOT in index.files)", async () => {
    const index = makeIndex(
      [],
      [makeFile("src/main.ts")],
    );
    mockGetCodeIndex.mockResolvedValue(index);
    mockReadFile.mockResolvedValue("See src/main.ts and src/missing.ts for details.");

    const result = await auditAgentConfig("test", { config_path: "/test-repo/CLAUDE.md" });

    expect(result.dead_paths).toEqual([
      { path: "src/missing.ts", line: 1 },
    ]);
  });

  it("returns positive token_cost", async () => {
    const index = makeIndex([], []);
    mockGetCodeIndex.mockResolvedValue(index);
    mockReadFile.mockResolvedValue("Some config content that has a reasonable length.");

    const result = await auditAgentConfig("test", { config_path: "/test-repo/CLAUDE.md" });

    expect(result.token_cost).toBeGreaterThan(0);
    expect(typeof result.token_cost).toBe("number");
  });

  it("throws on missing repo index", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    await expect(auditAgentConfig("missing-repo")).rejects.toThrow(
      /No index found for repo "missing-repo"/,
    );
  });

  it("throws on missing config file (ENOENT)", async () => {
    const index = makeIndex([], []);
    mockGetCodeIndex.mockResolvedValue(index);
    const enoent = new Error("ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);

    await expect(
      auditAgentConfig("test", { config_path: "/nonexistent/CLAUDE.md" }),
    ).rejects.toThrow(/Config file not found/);
  });

  it("detects redundancy: two files with 5+ identical lines", async () => {
    const index = makeIndex([], []);
    mockGetCodeIndex.mockResolvedValue(index);

    const sharedBlock = [
      "## Rules",
      "- Always use TypeScript",
      "- Always write tests",
      "- Never skip linting",
      "- Use strict mode",
    ].join("\n");

    const fileA = `# Config A\n${sharedBlock}\n# End A`;
    const fileB = `# Config B\n${sharedBlock}\n# End B`;

    // First call reads the main config, second call reads compare_with
    mockReadFile
      .mockResolvedValueOnce(fileA)
      .mockResolvedValueOnce(fileB);

    const result = await auditAgentConfig("test", {
      config_path: "/test-repo/CLAUDE.md",
      compare_with: "/test-repo/.cursorrules",
    });

    expect(result.redundant_blocks.length).toBeGreaterThan(0);
    expect(result.redundant_blocks[0].found_in).toEqual([
      "/test-repo/CLAUDE.md",
      "/test-repo/.cursorrules",
    ]);
    expect(result.redundant_blocks[0].text).toContain("Always use TypeScript");
  });

  it("does NOT report symbols that ARE in the index as stale", async () => {
    const index = makeIndex(
      [makeSymbol("createUser"), makeSymbol("OrderService")],
      [makeFile("src/main.ts")],
    );
    mockGetCodeIndex.mockResolvedValue(index);
    mockReadFile.mockResolvedValue("Use `createUser` and `OrderService` here.");

    const result = await auditAgentConfig("test", { config_path: "/test-repo/CLAUDE.md" });

    expect(result.stale_symbols).toEqual([]);
  });
});
