import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports of mocked modules
// ---------------------------------------------------------------------------

const mockScan = vi.fn<(input: string) => Array<{
  rule: string;
  label: string;
  text: string;
  confidence: "high" | "medium";
  start: number;
  end: number;
}>>();

vi.mock("@sanity-labs/secret-scan", () => ({
  scan: (...args: unknown[]) => mockScan(args[0] as string),
}));

const mockReadFile = vi.fn<(path: string) => Promise<Buffer>>();
const mockStat = vi.fn<(path: string) => Promise<{ mtimeMs: number }>>();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(args[0] as string),
  stat: (...args: unknown[]) => mockStat(args[0] as string),
}));

const mockGetCodeIndex = vi.fn<(repo: string) => Promise<CodeIndex | null>>();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: unknown[]) => mockGetCodeIndex(args[0] as string),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import {
  maskSecret,
  isDocFile,
  classifyContext,
  getSeverity,
  isAllowlisted,
  offsetToLine,
  scanFileForSecrets,
  enrichWithSymbolContext,
  scanSecrets,
  onFileChanged,
  onFileDeleted,
  resetSecretCache,
  getSecretCache,
  SEVERITY_MAP,
} from "../../src/tools/secret-tools.js";
import type { SecretFinding, SecretContext } from "../../src/tools/secret-tools.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(
  overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "name" | "file">,
): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 20,
    ...overrides,
  };
}

function makeFileEntry(path: string, overrides?: Partial<FileEntry>): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count: 1,
    last_modified: Date.now(),
    mtime_ms: Date.now(),
    ...overrides,
  };
}

function makeIndex(
  files: FileEntry[],
  symbols: CodeSymbol[] = [],
): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files,
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

function makeFinding(overrides?: Partial<SecretFinding>): SecretFinding {
  return {
    rule: "openai",
    label: "OpenAI",
    masked_secret: "sk-p***key1",
    confidence: "high",
    severity: "high",
    file: "src/config.ts",
    line: 5,
    context: { type: "production" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSecretCache();
  vi.clearAllMocks();
});

// ===== maskSecret =====

describe("maskSecret", () => {
  it("returns **** for empty string", () => {
    expect(maskSecret("")).toBe("****");
  });

  it("returns **** for strings shorter than 8 chars", () => {
    expect(maskSecret("abc")).toBe("****");
    expect(maskSecret("1234567")).toBe("****");
  });

  it("masks exactly 8-char string with first4 + *** + last4", () => {
    expect(maskSecret("12345678")).toBe("1234***5678");
  });

  it("masks long strings with first4 + *** + last4", () => {
    expect(maskSecret("sk-proj-abcdef123456")).toBe("sk-p***3456");
  });

  it("masks a 9-char string", () => {
    expect(maskSecret("123456789")).toBe("1234***6789");
  });
});

// ===== isDocFile =====

describe("isDocFile", () => {
  it("returns true for .md", () => {
    expect(isDocFile("README.md")).toBe(true);
  });

  it("returns true for .mdx", () => {
    expect(isDocFile("docs/intro.mdx")).toBe(true);
  });

  it("returns true for .txt", () => {
    expect(isDocFile("notes.txt")).toBe(true);
  });

  it("returns true for .rst", () => {
    expect(isDocFile("docs/index.rst")).toBe(true);
  });

  it("returns false for .ts", () => {
    expect(isDocFile("src/main.ts")).toBe(false);
  });

  it("returns false for .js", () => {
    expect(isDocFile("index.js")).toBe(false);
  });
});

// ===== classifyContext =====

describe("classifyContext", () => {
  it('returns "test" for test files', () => {
    expect(classifyContext("src/utils/__tests__/helper.ts")).toBe("test");
    expect(classifyContext("src/utils/helper.test.ts")).toBe("test");
    expect(classifyContext("src/utils/helper.spec.ts")).toBe("test");
  });

  it('returns "doc" for documentation files', () => {
    expect(classifyContext("README.md")).toBe("doc");
    expect(classifyContext("docs/guide.mdx")).toBe("doc");
  });

  it('returns "config" for .env files', () => {
    expect(classifyContext(".env")).toBe("config");
    expect(classifyContext(".env.local")).toBe("config");
    expect(classifyContext(".env.production")).toBe("config");
  });

  it('returns "config" for yaml/yml files', () => {
    expect(classifyContext("docker-compose.yaml")).toBe("config");
    expect(classifyContext("config.yml")).toBe("config");
  });

  it('returns "config" for toml/ini/cfg files', () => {
    expect(classifyContext("pyproject.toml")).toBe("config");
    expect(classifyContext("setup.cfg")).toBe("config");
    expect(classifyContext("config.ini")).toBe("config");
  });

  it('returns "production" for source files', () => {
    expect(classifyContext("src/main.ts")).toBe("production");
    expect(classifyContext("src/utils/helper.ts")).toBe("production");
    expect(classifyContext("index.js")).toBe("production");
  });

  it('does not return "config" for package.json', () => {
    expect(classifyContext("package.json")).toBe("production");
  });
});

// ===== getSeverity =====

describe("getSeverity", () => {
  it("returns critical for AWS rules", () => {
    expect(getSeverity("aws")).toBe("critical");
    expect(getSeverity("aws-secret")).toBe("critical");
  });

  it("returns high for openai", () => {
    expect(getSeverity("openai")).toBe("high");
  });

  it("returns medium for generic-api-key", () => {
    expect(getSeverity("generic-api-key")).toBe("medium");
  });

  it("returns medium for unknown rules", () => {
    expect(getSeverity("unknown-rule-xyz")).toBe("medium");
  });
});

// ===== isAllowlisted =====

describe("isAllowlisted", () => {
  it("returns true when comment is on the same line", () => {
    const lines = [
      'const key = "sk-test-1234"; // codesift:allow-secret',
    ];
    expect(isAllowlisted(lines, 1)).toBe(true);
  });

  it("returns true when comment is on the previous line", () => {
    const lines = [
      "// codesift:allow-secret",
      'const key = "sk-test-1234";',
    ];
    expect(isAllowlisted(lines, 2)).toBe(true);
  });

  it("returns false when no comment present", () => {
    const lines = [
      'const key = "sk-test-1234";',
      "console.log(key);",
    ];
    expect(isAllowlisted(lines, 1)).toBe(false);
  });

  it("returns false when comment is on line below", () => {
    const lines = [
      'const key = "sk-test-1234";',
      "// codesift:allow-secret",
    ];
    expect(isAllowlisted(lines, 1)).toBe(false);
  });

  it("handles line 1 correctly (no line above)", () => {
    const lines = ['const key = "sk-test-1234";'];
    expect(isAllowlisted(lines, 1)).toBe(false);
  });
});

// ===== offsetToLine =====

describe("offsetToLine", () => {
  const content = "line1\nline2\nline3\nline4";

  it("returns 1 for offset 0", () => {
    expect(offsetToLine(content, 0)).toBe(1);
  });

  it("returns 1 for offset within first line", () => {
    expect(offsetToLine(content, 3)).toBe(1);
  });

  it("returns 2 for offset at start of second line", () => {
    // "line1\n" is 6 chars, so offset 6 is start of line 2
    expect(offsetToLine(content, 6)).toBe(2);
  });

  it("returns 3 for offset in third line", () => {
    // "line1\nline2\n" is 12 chars, offset 12 = start of line 3
    expect(offsetToLine(content, 12)).toBe(3);
  });

  it("returns 4 for offset in last line", () => {
    expect(offsetToLine(content, 18)).toBe(4);
  });

  it("handles empty content", () => {
    expect(offsetToLine("", 0)).toBe(1);
  });
});

// ===== enrichWithSymbolContext =====

describe("enrichWithSymbolContext", () => {
  it("adds symbol_name and kind when symbol overlaps", () => {
    const finding = makeFinding({ file: "src/config.ts", line: 5 });
    const symbols = [
      makeSymbol({
        name: "loadConfig",
        file: "src/config.ts",
        start_line: 1,
        end_line: 10,
      }),
    ];

    const result = enrichWithSymbolContext(finding, symbols);
    expect(result.context.symbol_name).toBe("loadConfig");
    expect(result.context.symbol_kind).toBe("function");
  });

  it("returns finding unchanged when no symbol matches", () => {
    const finding = makeFinding({ file: "src/config.ts", line: 50 });
    const symbols = [
      makeSymbol({
        name: "loadConfig",
        file: "src/config.ts",
        start_line: 1,
        end_line: 10,
      }),
    ];

    const result = enrichWithSymbolContext(finding, symbols);
    expect(result.context.symbol_name).toBeUndefined();
  });

  it("demotes confidence when symbol name looks like a placeholder", () => {
    const finding = makeFinding({
      file: "src/config.ts",
      line: 5,
      confidence: "high",
    });
    const symbols = [
      makeSymbol({
        name: "testApiKey",
        file: "src/config.ts",
        start_line: 1,
        end_line: 10,
      }),
    ];

    const result = enrichWithSymbolContext(finding, symbols);
    expect(result.confidence).toBe("low");
  });

  it("demotes for placeholder names like EXAMPLE_KEY", () => {
    const finding = makeFinding({
      file: "src/config.ts",
      line: 5,
      confidence: "high",
    });
    const symbols = [
      makeSymbol({
        name: "EXAMPLE_KEY",
        file: "src/config.ts",
        start_line: 1,
        end_line: 10,
      }),
    ];

    const result = enrichWithSymbolContext(finding, symbols);
    expect(result.confidence).toBe("low");
  });

  it("does not demote for normal symbol names", () => {
    const finding = makeFinding({
      file: "src/config.ts",
      line: 5,
      confidence: "high",
    });
    const symbols = [
      makeSymbol({
        name: "initializeAuth",
        file: "src/config.ts",
        start_line: 1,
        end_line: 10,
      }),
    ];

    const result = enrichWithSymbolContext(finding, symbols);
    expect(result.confidence).toBe("high");
  });
});

// ===== scanFileForSecrets =====

describe("scanFileForSecrets", () => {
  const defaultContent = 'const API_KEY = "sk-proj-abcdef1234567890";';
  const defaultContentBuffer = Buffer.from(defaultContent);

  beforeEach(() => {
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockResolvedValue(defaultContentBuffer);
    mockScan.mockReturnValue([]);
  });

  it("returns empty array for a clean file", async () => {
    mockScan.mockReturnValue([]);

    const result = await scanFileForSecrets(
      "/tmp/test/src/clean.ts",
      "src/clean.ts",
      "test",
      [],
    );

    expect(result).toEqual([]);
  });

  it("returns findings for a file with a secret", async () => {
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 17,
        end: 41,
      },
    ]);

    const result = await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.rule).toBe("openai");
    expect(result[0]!.masked_secret).toBe("sk-p***7890");
    expect(result[0]!.severity).toBe("high");
    expect(result[0]!.confidence).toBe("high");
    expect(result[0]!.line).toBe(1);
    expect(result[0]!.context.type).toBe("production");
  });

  it("filters out allowlisted secrets", async () => {
    const contentWithAllow =
      'const API_KEY = "sk-proj-abc12345678"; // codesift:allow-secret';
    mockReadFile.mockResolvedValue(Buffer.from(contentWithAllow));
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abc12345678",
        confidence: "high" as const,
        start: 17,
        end: 36,
      },
    ]);

    const result = await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    expect(result).toHaveLength(0);
  });

  it("skips binary files", async () => {
    const binaryBuffer = Buffer.alloc(100);
    binaryBuffer[10] = 0; // null byte
    mockReadFile.mockResolvedValue(binaryBuffer);

    const result = await scanFileForSecrets(
      "/tmp/test/binary.bin",
      "binary.bin",
      "test",
      [],
    );

    expect(result).toEqual([]);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("returns cached results on cache hit (same mtime)", async () => {
    // First call — populate cache
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 17,
        end: 41,
      },
    ]);

    await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    // Second call — should use cache
    mockScan.mockClear();
    const result = await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    expect(result).toHaveLength(1);
    expect(mockReadFile).toHaveBeenCalledTimes(1); // Only the first call read the file
  });

  it("re-scans on cache miss (mtime changed)", async () => {
    // First call
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 17,
        end: 41,
      },
    ]);

    await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    // Change mtime
    mockStat.mockResolvedValue({ mtimeMs: 2000 });
    mockScan.mockReturnValue([]); // File cleaned up

    const result = await scanFileForSecrets(
      "/tmp/test/src/config.ts",
      "src/config.ts",
      "test",
      [],
    );

    expect(result).toHaveLength(0);
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it("demotes confidence for test files", async () => {
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 17,
        end: 41,
      },
    ]);

    const result = await scanFileForSecrets(
      "/tmp/test/src/config.test.ts",
      "src/config.test.ts",
      "test",
      [],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe("low");
  });

  it("skips lock files", async () => {
    const result = await scanFileForSecrets(
      "/tmp/test/package-lock.json",
      "package-lock.json",
      "test",
      [],
    );

    expect(result).toEqual([]);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("skips minified files", async () => {
    const result = await scanFileForSecrets(
      "/tmp/test/dist/bundle.min.js",
      "dist/bundle.min.js",
      "test",
      [],
    );

    expect(result).toEqual([]);
    expect(mockScan).not.toHaveBeenCalled();
  });
});

// ===== scanSecrets (integration with mocked boundaries) =====

describe("scanSecrets", () => {
  beforeEach(() => {
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockResolvedValue(Buffer.from('const x = "hello";'));
    mockScan.mockReturnValue([]);
  });

  it("throws when repo not found", async () => {
    mockGetCodeIndex.mockResolvedValue(null);
    await expect(scanSecrets("unknown-repo")).rejects.toThrow(
      'Repository "unknown-repo" not found',
    );
  });

  it("returns correct result shape with no findings", async () => {
    const index = makeIndex([makeFileEntry("src/main.ts")]);
    mockGetCodeIndex.mockResolvedValue(index);

    const result = await scanSecrets("test");

    expect(result).toEqual({
      findings: [],
      files_scanned: 1,
      files_with_secrets: 0,
      scan_coverage: "full",
    });
  });

  it("returns findings when secrets detected", async () => {
    const index = makeIndex([makeFileEntry("src/config.ts")]);
    mockGetCodeIndex.mockResolvedValue(index);

    mockScan.mockReturnValue([
      {
        rule: "aws",
        label: "AWS",
        text: "AKIAIOSFODNN7EXAMPLE",
        confidence: "high" as const,
        start: 10,
        end: 30,
      },
    ]);

    const result = await scanSecrets("test");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule).toBe("aws");
    expect(result.findings[0]!.severity).toBe("critical");
    expect(result.files_with_secrets).toBe(1);
  });

  it("filters by min_confidence", async () => {
    const index = makeIndex([
      makeFileEntry("src/config.test.ts"),
    ]);
    mockGetCodeIndex.mockResolvedValue(index);

    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 10,
        end: 30,
      },
    ]);

    // Test file → demoted to "low"
    const result = await scanSecrets("test", { min_confidence: "medium" });
    expect(result.findings).toHaveLength(0);
  });

  it("excludes test files when exclude_tests=true", async () => {
    const index = makeIndex([
      makeFileEntry("src/config.ts"),
      makeFileEntry("src/config.test.ts"),
    ]);
    mockGetCodeIndex.mockResolvedValue(index);

    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high" as const,
        start: 10,
        end: 30,
      },
    ]);

    const result = await scanSecrets("test", { exclude_tests: true });
    // Only src/config.ts should be scanned, not the test file
    expect(result.files_scanned).toBe(1);
  });

  it("skips lock files in scanSecrets", async () => {
    const index = makeIndex([
      makeFileEntry("package-lock.json"),
      makeFileEntry("src/main.ts"),
    ]);
    mockGetCodeIndex.mockResolvedValue(index);

    const result = await scanSecrets("test");
    // package-lock.json should be skipped, only main.ts scanned
    expect(result.files_scanned).toBe(1);
  });

  it("caps results at max_results", async () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFileEntry(`src/file${i}.ts`),
    );
    const index = makeIndex(files);
    mockGetCodeIndex.mockResolvedValue(index);

    mockScan.mockReturnValue([
      {
        rule: "generic-api-key",
        label: "Generic API Key",
        text: "key-abcdef1234567890",
        confidence: "medium" as const,
        start: 0,
        end: 20,
      },
      {
        rule: "generic-api-key",
        label: "Generic API Key",
        text: "key-zzzzzzz987654321",
        confidence: "medium" as const,
        start: 25,
        end: 45,
      },
    ]);

    const result = await scanSecrets("test", { max_results: 3 });
    expect(result.findings.length).toBeLessThanOrEqual(3);
  });
});

// ===== onFileChanged / onFileDeleted =====

describe("watcher hooks", () => {
  it("onFileChanged removes cache entry", async () => {
    // Populate cache
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockResolvedValue(Buffer.from("clean file"));
    mockScan.mockReturnValue([]);

    await scanFileForSecrets(
      "/tmp/test/src/file.ts",
      "src/file.ts",
      "test-repo",
      [],
    );

    const cache = getSecretCache();
    expect(cache.get("test-repo")?.has("src/file.ts")).toBe(true);

    onFileChanged("test-repo", "src/file.ts");
    expect(cache.get("test-repo")?.has("src/file.ts")).toBe(false);
  });

  it("onFileDeleted removes cache entry", async () => {
    // Populate cache
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockResolvedValue(Buffer.from("clean file"));
    mockScan.mockReturnValue([]);

    await scanFileForSecrets(
      "/tmp/test/src/file.ts",
      "src/file.ts",
      "test-repo",
      [],
    );

    const cache = getSecretCache();
    expect(cache.get("test-repo")?.has("src/file.ts")).toBe(true);

    onFileDeleted("test-repo", "src/file.ts");
    expect(cache.get("test-repo")?.has("src/file.ts")).toBe(false);
  });

  it("onFileChanged handles missing repo cache gracefully", () => {
    expect(() => onFileChanged("nonexistent", "file.ts")).not.toThrow();
  });

  it("onFileDeleted handles missing repo cache gracefully", () => {
    expect(() => onFileDeleted("nonexistent", "file.ts")).not.toThrow();
  });
});
