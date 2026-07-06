import { describe, it, expect, vi, beforeEach } from "vitest";
import { indexStatus } from "../../src/tools/status-tools.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — I/O boundaries
// ---------------------------------------------------------------------------

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();
const mockResolveRegisteredRepoMeta = vi.fn();
const mockLoadIndexOrStale = vi.fn();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

vi.mock("../../src/storage/registry.js", () => ({
  resolveRegisteredRepoMeta: (...args: unknown[]) => mockResolveRegisteredRepoMeta(...args),
}));

vi.mock("../../src/storage/index-store.js", () => ({
  loadIndexOrStale: (...args: unknown[]) => mockLoadIndexOrStale(...args),
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({ registryPath: "/tmp/test-registry.json" }),
}));

vi.mock("../../src/tools/index-shared.js", () => ({
  EXTRACTOR_VERSIONS: { typescript: "3.0.0", python: "1.0.0" },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<FileEntry> & Pick<FileEntry, "path" | "language">): FileEntry {
  return {
    symbol_count: 0,
    last_modified: Date.now(),
    ...overrides,
  };
}

function makeIndex(files: FileEntry[]): CodeIndex {
  const now = Date.now();
  return {
    repo: "test",
    root: "/test",
    symbols: [],
    files,
    created_at: now,
    updated_at: now,
    symbol_count: files.reduce((sum, f) => sum + f.symbol_count, 0),
    file_count: files.length,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("indexStatus", () => {
  beforeEach(() => {
    mockGetCodeIndex.mockReset();
    mockResolveRegisteredRepoMeta.mockReset();
    mockLoadIndexOrStale.mockReset();
    mockResolveRegisteredRepoMeta.mockResolvedValue(null);
    mockLoadIndexOrStale.mockResolvedValue(null);
  });

  it("returns {indexed: false} when getCodeIndex returns null and no registry entry exists", async () => {
    mockGetCodeIndex.mockResolvedValue(null);

    const result = await indexStatus("missing-repo");

    expect(result).toEqual({ indexed: false });
    expect(mockGetCodeIndex).toHaveBeenCalledWith("missing-repo");
    expect(mockResolveRegisteredRepoMeta).toHaveBeenCalled();
  });

  it("surfaces structured stale info when extractor_version drifted", async () => {
    mockGetCodeIndex.mockResolvedValue(null);
    mockResolveRegisteredRepoMeta.mockResolvedValue({
      resolvedName: "local/translation-qa",
      meta: {
        name: "local/translation-qa",
        root: "/Users/test/translation-qa",
        index_path: "/tmp/translation-qa.index.json",
        symbol_count: 0,
        file_count: 0,
        updated_at: 0,
      },
    });
    mockLoadIndexOrStale.mockResolvedValue({
      status: "stale",
      reason: "extractor_version_mismatch",
      language: "typescript",
      expected_version: "3.0.0",
      actual_version: "missing",
    });

    const result = await indexStatus("local/translation-qa");

    expect(result.indexed).toBe(false);
    expect(result.stale).toEqual({
      reason: "extractor_version_mismatch",
      language: "typescript",
      expected_version: "3.0.0",
      actual_version: "missing",
    });
  });

  it("returns full status with file_count, symbol_count, and language_breakdown", async () => {
    const files = [
      makeFile({ path: "src/main.ts", language: "typescript", symbol_count: 10 }),
      makeFile({ path: "src/util.ts", language: "typescript", symbol_count: 5 }),
      makeFile({ path: "src/app.py", language: "python", symbol_count: 3 }),
    ];
    mockGetCodeIndex.mockResolvedValue(makeIndex(files));

    const result = await indexStatus("test");

    expect(result.indexed).toBe(true);
    expect(result.file_count).toBe(3);
    expect(result.symbol_count).toBe(18);
    expect(result.language_breakdown).toEqual({
      typescript: 2,
      python: 1,
    });
    expect(result.last_indexed).toBeDefined();
    expect(typeof result.last_indexed).toBe("string");
    // ISO date format
    expect(result.last_indexed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("identifies text_stub_languages (kotlin, swift, dart)", async () => {
    const files = [
      makeFile({ path: "src/Main.kt", language: "kotlin", symbol_count: 0 }),
      makeFile({ path: "ios/App.swift", language: "swift", symbol_count: 0 }),
      makeFile({ path: "lib/main.dart", language: "dart", symbol_count: 0 }),
      makeFile({ path: "src/main.ts", language: "typescript", symbol_count: 5 }),
    ];
    mockGetCodeIndex.mockResolvedValue(makeIndex(files));

    const result = await indexStatus("test");

    expect(result.indexed).toBe(true);
    expect(result.text_stub_languages).toBeDefined();
    expect(result.text_stub_languages).toEqual(["dart", "kotlin", "swift"]);
  });

  it("returns no text_stub_languages field when no text_stub files exist", async () => {
    const files = [
      makeFile({ path: "src/main.ts", language: "typescript", symbol_count: 10 }),
      makeFile({ path: "src/app.py", language: "python", symbol_count: 3 }),
      makeFile({ path: "cmd/main.go", language: "go", symbol_count: 2 }),
    ];
    mockGetCodeIndex.mockResolvedValue(makeIndex(files));

    const result = await indexStatus("test");

    expect(result.indexed).toBe(true);
    expect(result.text_stub_languages).toBeUndefined();
    expect("text_stub_languages" in result).toBe(false);
  });

  it("deduplicates text_stub_languages when multiple files share a language", async () => {
    const files = [
      makeFile({ path: "src/A.kt", language: "kotlin", symbol_count: 0 }),
      makeFile({ path: "src/B.kt", language: "kotlin", symbol_count: 0 }),
      makeFile({ path: "src/C.kt", language: "kotlin", symbol_count: 0 }),
    ];
    mockGetCodeIndex.mockResolvedValue(makeIndex(files));

    const result = await indexStatus("test");

    expect(result.text_stub_languages).toEqual(["kotlin"]);
    expect(result.language_breakdown).toEqual({ kotlin: 3 });
  });

  it("handles empty file list", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([]));

    const result = await indexStatus("test");

    expect(result.indexed).toBe(true);
    expect(result.file_count).toBe(0);
    expect(result.symbol_count).toBe(0);
    expect(result.language_breakdown).toEqual({});
    expect(result.text_stub_languages).toBeUndefined();
  });
});
