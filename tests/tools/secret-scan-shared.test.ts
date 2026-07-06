import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeSymbol } from "../../src/types.js";

const mockScan = vi.fn<(input: string) => Array<{
  rule: string;
  label: string;
  text: string;
  confidence: "high" | "medium" | "low";
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

import {
  classifyContext,
  enrichWithSymbolContext,
  getSecretCache,
  getSeverity,
  isAllowlisted,
  isDocFile,
  isMissingFileError,
  maskSecret,
  offsetToLine,
  onFileChanged,
  onFileDeleted,
  resetSecretCache,
  scanFileForSecrets,
  severityAtLeast,
  shouldSkipFile,
} from "../../src/tools/secret-scan-shared.js";
import type { SecretFinding } from "../../src/tools/secret-scan-shared.js";

function makeSymbol(overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "name" | "file">): CodeSymbol {
  return {
    id: `test:${overrides.file}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 20,
    ...overrides,
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

beforeEach(() => {
  resetSecretCache();
  vi.clearAllMocks();
  mockStat.mockResolvedValue({ mtimeMs: 1000 });
  mockReadFile.mockResolvedValue(Buffer.from('const API_KEY = "sk-proj-abcdef1234567890";'));
  mockScan.mockReturnValue([]);
});

describe("secret scan shared pure helpers", () => {
  it("masks short and long secrets with safe display values", () => {
    expect(maskSecret("")).toBe("****");
    expect(maskSecret("1234567")).toBe("****");
    expect(maskSecret("12345678")).toBe("1234***5678");
    expect(maskSecret("sk-proj-abcdef123456")).toBe("sk-p***3456");
  });

  it("classifies doc, test, config, and production paths", () => {
    expect(isDocFile("docs/guide.mdx")).toBe(true);
    expect(isDocFile("src/main.ts")).toBe(false);
    expect(classifyContext("src/config.test.ts")).toBe("test");
    expect(classifyContext("README.md")).toBe("doc");
    expect(classifyContext(".env.local")).toBe("config");
    expect(classifyContext("config/secrets.json")).toBe("config");
    expect(classifyContext("package.json")).toBe("production");
    expect(classifyContext("src/main.ts")).toBe("production");
  });

  it("maps known severities and preserves medium fallback for unknown rules", () => {
    expect(getSeverity("aws")).toBe("critical");
    expect(getSeverity("openai")).toBe("high");
    expect(getSeverity("generic-api-key")).toBe("medium");
    expect(getSeverity("unknown-rule")).toBe("medium");
  });

  it("compares severities against a minimum threshold", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("medium", "medium")).toBe(true);
    expect(severityAtLeast("low", "medium")).toBe(false);
  });

  it("detects ENOENT-shaped missing file errors only", () => {
    expect(isMissingFileError({ code: "ENOENT" })).toBe(true);
    expect(isMissingFileError({ code: "EACCES" })).toBe(false);
    expect(isMissingFileError(new Error("missing"))).toBe(false);
  });

  it("detects inline allowlist markers on the same or previous line", () => {
    expect(isAllowlisted(['const key = "sk-test"; // codesift:allow-secret'], 1)).toBe(true);
    expect(isAllowlisted(["// codesift:allow-secret", 'const key = "sk-test";'], 2)).toBe(true);
    expect(isAllowlisted(['const key = "sk-test";', "// codesift:allow-secret"], 1)).toBe(false);
    expect(isAllowlisted(['const key = "sk-test";'], 1)).toBe(false);
  });

  it("maps byte offsets to one-based line numbers", () => {
    const content = "line1\nline2\nline3";

    expect(offsetToLine(content, 0)).toBe(1);
    expect(offsetToLine(content, 6)).toBe(2);
    expect(offsetToLine(content, 12)).toBe(3);
    expect(offsetToLine("", 0)).toBe(1);
  });

  it("skips known generated files and leaves normal source paths scannable", () => {
    expect(shouldSkipFile("package-lock.json")).toBe(true);
    expect(shouldSkipFile("dist/app.min.js")).toBe(true);
    expect(shouldSkipFile("audits/artifacts/report.ts")).toBe(true);
    expect(shouldSkipFile("src/config.ts")).toBe(false);
  });
});

describe("enrichWithSymbolContext", () => {
  it("adds matching symbol context and preserves normal confidence", () => {
    const result = enrichWithSymbolContext(
      makeFinding({ file: "src/config.ts", line: 5 }),
      [makeSymbol({ name: "initializeAuth", file: "src/config.ts", start_line: 1, end_line: 10 })],
    );

    expect(result.context).toEqual({
      type: "production",
      symbol_name: "initializeAuth",
      symbol_kind: "function",
    });
    expect(result.confidence).toBe("high");
  });

  it("returns the finding unchanged when no symbol range matches", () => {
    const finding = makeFinding({ file: "src/config.ts", line: 50 });

    expect(enrichWithSymbolContext(
      finding,
      [makeSymbol({ name: "initializeAuth", file: "src/config.ts", start_line: 1, end_line: 10 })],
    )).toBe(finding);
  });

  it("demotes confidence for placeholder-like symbol names", () => {
    const result = enrichWithSymbolContext(
      makeFinding({ confidence: "high" }),
      [makeSymbol({ name: "EXAMPLE_KEY", file: "src/config.ts", start_line: 1, end_line: 10 })],
    );

    expect(result.confidence).toBe("low");
  });
});

describe("scanFileForSecrets", () => {
  it("returns an empty result for a clean file and caches it", async () => {
    const result = await scanFileForSecrets("/tmp/test/src/clean.ts", "src/clean.ts", "test", []);

    expect(result).toEqual([]);
    expect(mockScan).toHaveBeenCalledWith('const API_KEY = "sk-proj-abcdef1234567890";');
    expect(getSecretCache().get("test")?.get("src/clean.ts")).toEqual({
      mtime_ms: 1000,
      findings: [],
    });
  });

  it("maps scanner output to masked findings with severity and production context", async () => {
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high",
        start: 17,
        end: 41,
      },
    ]);

    const result = await scanFileForSecrets("/tmp/test/src/config.ts", "src/config.ts", "test", []);

    expect(result).toEqual([
      {
        rule: "openai",
        label: "OpenAI",
        masked_secret: "sk-p***7890",
        confidence: "high",
        severity: "high",
        file: "src/config.ts",
        line: 1,
        context: { type: "production" },
      },
    ]);
  });

  it("filters allowlisted findings before they reach the cache", async () => {
    const content = 'const API_KEY = "sk-proj-abc12345678"; // codesift:allow-secret';
    mockReadFile.mockResolvedValue(Buffer.from(content));
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abc12345678",
        confidence: "high",
        start: 17,
        end: 36,
      },
    ]);

    const result = await scanFileForSecrets("/tmp/test/src/config.ts", "src/config.ts", "test", []);

    expect(result).toEqual([]);
    expect(getSecretCache().get("test")?.get("src/config.ts")?.findings).toEqual([]);
  });

  it("skips binary files and oversized files without scanner calls", async () => {
    const binaryBuffer = Buffer.alloc(100);
    binaryBuffer[10] = 0;
    mockReadFile.mockResolvedValueOnce(binaryBuffer);

    expect(await scanFileForSecrets("/tmp/test/bin.dat", "bin.dat", "test", [])).toEqual([]);
    expect(mockScan).not.toHaveBeenCalled();

    resetSecretCache();
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockResolvedValue(Buffer.alloc(500 * 1024 + 1, "a"));

    expect(await scanFileForSecrets("/tmp/test/src/large.ts", "src/large.ts", "test", [])).toEqual([]);
    expect(mockScan).not.toHaveBeenCalled();
    expect(getSecretCache().get("test")?.get("src/large.ts")).toEqual({
      mtime_ms: 1000,
      findings: [],
    });
  });

  it("skips generated paths before reading file content", async () => {
    const result = await scanFileForSecrets(
      "/tmp/test/audits/artifacts/report.ts",
      "audits/artifacts/report.ts",
      "test",
      [],
    );

    expect(result).toEqual([]);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("returns cached findings until mtime changes", async () => {
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high",
        start: 17,
        end: 41,
      },
    ]);

    await scanFileForSecrets("/tmp/test/src/config.ts", "src/config.ts", "test", []);

    mockScan.mockClear();
    expect(await scanFileForSecrets("/tmp/test/src/config.ts", "src/config.ts", "test", [])).toHaveLength(1);
    expect(mockReadFile).toHaveBeenCalledTimes(1);

    mockStat.mockResolvedValue({ mtimeMs: 2000 });
    mockScan.mockReturnValue([]);
    expect(await scanFileForSecrets("/tmp/test/src/config.ts", "src/config.ts", "test", [])).toEqual([]);
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it("demotes test and documentation findings and enriches doc symbols with multi-line offsets", async () => {
    mockScan.mockReturnValueOnce([
      {
        rule: "openai",
        label: "OpenAI",
        text: "sk-proj-abcdef1234567890",
        confidence: "high",
        start: 17,
        end: 41,
      },
    ]);

    const testResult = await scanFileForSecrets(
      "/tmp/test/src/config.test.ts",
      "src/config.test.ts",
      "test",
      [],
    );
    expect(testResult[0]!.confidence).toBe("low");

    resetSecretCache();
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    const docContent = 'intro\nconst DOC_KEY = "sk-proj-docabcdef123456";';
    const secretText = "sk-proj-docabcdef123456";
    mockReadFile.mockResolvedValue(Buffer.from(docContent));
    mockScan.mockReturnValue([
      {
        rule: "openai",
        label: "OpenAI",
        text: secretText,
        confidence: "high",
        start: docContent.indexOf(secretText),
        end: docContent.indexOf(secretText) + secretText.length,
      },
    ]);

    const docResult = await scanFileForSecrets(
      "/tmp/test/docs/guide.md",
      "docs/guide.md",
      "test",
      [makeSymbol({ name: "loadDocs", file: "docs/guide.md", start_line: 2, end_line: 2 })],
    );

    expect(docResult[0]!.line).toBe(2);
    expect(docResult[0]!.confidence).toBe("low");
    expect(docResult[0]!.context).toEqual({
      type: "doc",
      symbol_name: "loadDocs",
      symbol_kind: "function",
    });
  });
});

describe("secret cache watcher hooks", () => {
  it("removes changed and deleted files from the cache", async () => {
    await scanFileForSecrets("/tmp/test/src/file.ts", "src/file.ts", "test", []);
    expect(getSecretCache().get("test")?.has("src/file.ts")).toBe(true);

    onFileChanged("test", "src/file.ts");
    expect(getSecretCache().get("test")?.has("src/file.ts")).toBe(false);

    await scanFileForSecrets("/tmp/test/src/file.ts", "src/file.ts", "test", []);
    onFileDeleted("test", "src/file.ts");
    expect(getSecretCache().get("test")?.has("src/file.ts")).toBe(false);
  });

  it("ignores watcher events for repos without a cache", () => {
    expect(() => onFileChanged("missing", "src/file.ts")).not.toThrow();
    expect(() => onFileDeleted("missing", "src/file.ts")).not.toThrow();
  });
});
