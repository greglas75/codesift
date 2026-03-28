# Implementation Plan: Secret Detection Tool (`scan_secrets`)

**Spec:** `docs/specs/2026-03-28-scan-secrets-spec.md`
**Created:** 2026-03-28
**Tasks:** 11
**Estimated complexity:** 9 standard, 2 complex

## Architecture Summary

- **NEW:** `src/tools/secret-tools.ts` — scanner, cache, masking, suppression, severity mapping (~200 lines)
- **Modify:** `src/parser/parser-manager.ts` — add config extensions to `EXTENSION_MAP`
- **Modify:** `src/tools/index-tools.ts` — config branch in `parseOneFile`, eager scan hook in `handleFileChange`/`handleFileDelete`
- **Modify:** `src/register-tools.ts` — append `scan_secrets` to `TOOL_DEFINITIONS`
- **Dependency:** `@sanity-labs/secret-scan` (MIT, 0 transitive deps)

Data flow: watcher → `handleFileChange` → `scanFileForSecrets(filePath)` → read raw content → `scan(content)` → map offsets to lines → enrich with AST context → mask → cache. `scan_secrets` tool reads from cache.

## Technical Decisions

- Per-file cache as `Map<string, SecretCacheEntry>` in `secret-tools.ts` (not in index-tools)
- Config files: add to `EXTENSION_MAP` as `"config"`, new branch in `parseOneFile` returning `{ symbols: [], entry }`
- Library confidence is base signal; CodeSift only demotes (test/doc/placeholder → low)
- Masking: strings <8 chars → `"****"` entirely; ≥8 chars → `first4 + "***" + last4`
- `isDocFile()` helper for `.md/.mdx/.txt/.rst` confidence demotion
- `resetSecretCache()` exported for test isolation

## Quality Strategy

- CQ3 activated: validate `repo` param, handle missing repo
- CQ6 activated: findings array could be large for repos with many secrets — cap at configurable limit
- CQ8 activated: `scan()` and `readFile()` can throw — try/catch with continue per file
- CQ14: reuse `isTestFile`, `getCodeIndex`, `wrapTool`, `walkDirectory`, `errorResult`
- Test framework: Vitest, tests in `tests/tools/secret-tools.test.ts` + integration in `tests/integration/`
- Mock boundary: `vi.mock("@sanity-labs/secret-scan")` for unit tests; real scanner in integration

---

## Task Breakdown

### Task 1: Install dependency and verify import
**Files:** `package.json`
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Verify the package is not yet installed
  ```bash
  node -e "import('@sanity-labs/secret-scan').then(m => console.log(Object.keys(m))).catch(() => console.log('NOT_INSTALLED'))"
  ```
  Expected: `NOT_INSTALLED`
- [ ] GREEN: Install the package
  ```bash
  npm install @sanity-labs/secret-scan
  ```
- [ ] Verify: `node -e "import('@sanity-labs/secret-scan').then(m => console.log('OK:', typeof m.scan === 'function'))"`
  Expected: `OK: true`
- [ ] Commit: `add @sanity-labs/secret-scan dependency for secret detection`

**Note:** Task 4 RED will include a proper vitest import verification test. This task is infra-only (npm install).

---

### Task 2: Add config extensions to EXTENSION_MAP + tests
**Files:** `src/parser/parser-manager.ts`, `tests/parser/parser-manager.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/parser/parser-manager.test.ts
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
  });
  ```
- [ ] GREEN: Add config extensions to `EXTENSION_MAP` in `src/parser/parser-manager.ts`
  ```typescript
  // In EXTENSION_MAP, change existing ".json": "json" to "config", and add new entries after ".jsonl": "conversation":
  // Change: ".json": "json" → ".json": "config"
  // Add:
  ".env": "config",
  ".yaml": "config",
  ".yml": "config",
  ".toml": "config",
  ".ini": "config",
  ".properties": "config",
  ```
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
  Expected: All tests pass
- [ ] Commit: `add config file extensions to EXTENSION_MAP for secret scanning support`

---

### Task 3: Config branch in parseOneFile + integration test
**Files:** `src/tools/index-tools.ts`, `tests/integration/config-files.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 2
**Model routing:** Sonnet

- [ ] RED: Write failing integration test
  ```typescript
  // tests/integration/config-files.test.ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { mkdtemp, writeFile, rm } from "node:fs/promises";
  import { join } from "node:path";
  import { tmpdir } from "node:os";
  import { indexFolder } from "../../src/tools/index-tools.js";
  import { resetConfigCache } from "../../src/config.js";

  describe("config file indexing (DD2)", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "codesift-config-"));
      process.env.CODESIFT_DATA_DIR = join(tempDir, ".codesift");
      resetConfigCache();
    });

    afterEach(async () => {
      delete process.env.CODESIFT_DATA_DIR;
      resetConfigCache();
      await rm(tempDir, { recursive: true, force: true });
    });

    it("indexes .env files as config with zero symbols", async () => {
      await writeFile(join(tempDir, ".env"), "API_KEY=secret123\nDB_URL=postgres://localhost");
      const result = await indexFolder(tempDir);
      const envEntry = result.files?.find((f: { path: string }) => f.path === ".env");
      expect(envEntry).toBeDefined();
      expect(envEntry!.language).toBe("config");
      expect(envEntry!.symbol_count).toBe(0);
    });

    it("indexes .yaml files as config with zero symbols", async () => {
      await writeFile(join(tempDir, "config.yaml"), "key: value\nlist:\n  - item1");
      const result = await indexFolder(tempDir);
      const yamlEntry = result.files?.find((f: { path: string }) => f.path === "config.yaml");
      expect(yamlEntry).toBeDefined();
      expect(yamlEntry!.language).toBe("config");
      expect(yamlEntry!.symbol_count).toBe(0);
    });
  });
  ```
- [ ] GREEN: Add config branch to `parseOneFile` in `src/tools/index-tools.ts`
  ```typescript
  // After the "conversation" branch (line 57), add before the else:
  } else if (language === "config") {
    symbols = [];
  } else {
  ```
  This replaces the existing `} else {` on the tree-sitter fallback.
- [ ] Verify: `npx vitest run tests/integration/config-files.test.ts`
  Expected: All tests pass
- [ ] Commit: `support config files (.env, .yaml, .toml) in index with zero symbols (DD2)`

---

### Task 4: Core secret-tools module — types, masking, helpers
**Files:** `src/tools/secret-tools.ts` (NEW), `tests/tools/secret-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] RED: Write failing tests for masking and helpers
  ```typescript
  // tests/tools/secret-tools.test.ts
  import { describe, it, expect } from "vitest";
  import { maskSecret, isDocFile, classifyContext, SEVERITY_MAP } from "../../src/tools/secret-tools.js";

  describe("maskSecret", () => {
    it("masks strings >= 8 chars as first4***last4", () => {
      expect(maskSecret("sk-proj-abcdefghij")).toBe("sk-p***ghij");
    });

    it("masks strings < 8 chars as ****", () => {
      expect(maskSecret("abc")).toBe("****");
    });

    it("masks empty string as ****", () => {
      expect(maskSecret("")).toBe("****");
    });

    it("masks exactly 8 chars correctly", () => {
      expect(maskSecret("12345678")).toBe("1234***5678");
    });
  });

  describe("isDocFile", () => {
    it("returns true for .md files", () => {
      expect(isDocFile("docs/README.md")).toBe(true);
    });

    it("returns true for .mdx files", () => {
      expect(isDocFile("components/Guide.mdx")).toBe(true);
    });

    it("returns true for .txt and .rst", () => {
      expect(isDocFile("notes.txt")).toBe(true);
      expect(isDocFile("docs/guide.rst")).toBe(true);
    });

    it("returns false for .ts files", () => {
      expect(isDocFile("src/app.ts")).toBe(false);
    });
  });

  describe("classifyContext", () => {
    it("returns 'test' for test files", () => {
      expect(classifyContext("src/app.test.ts")).toBe("test");
    });

    it("returns 'docs' for doc files", () => {
      expect(classifyContext("README.md")).toBe("docs");
    });

    it("returns 'config' for config files", () => {
      expect(classifyContext(".env")).toBe("config");
    });

    it("returns 'production' for regular source files", () => {
      expect(classifyContext("src/app.ts")).toBe("production");
    });
  });

  describe("SEVERITY_MAP", () => {
    it("maps aws to critical", () => {
      expect(SEVERITY_MAP["aws"]).toBe("critical");
    });

    it("maps openai to high", () => {
      expect(SEVERITY_MAP["openai"]).toBe("high");
    });
  });
  ```
- [ ] GREEN: Create `src/tools/secret-tools.ts` with types and pure helpers
  ```typescript
  // src/tools/secret-tools.ts
  import { isTestFile } from "../utils/test-file.js";
  import { extname } from "node:path";

  // --- Types ---
  export type SecretSeverity = "critical" | "high" | "medium" | "low";
  export type SecretContext = "production" | "test" | "config" | "docs" | "unknown";

  export interface SecretFinding {
    file: string;
    line: number;
    rule: string;
    label: string;
    severity: SecretSeverity;
    confidence: "high" | "medium" | "low";
    match_masked: string;
    context: SecretContext;
    symbol_name?: string;
    symbol_kind?: string;
  }

  export interface SecretCacheEntry {
    mtime_ms: number;
    findings: SecretFinding[];
  }

  export interface ScanSecretsResult {
    total_findings: number;
    files_scanned: number;
    files_with_secrets: number;
    scan_coverage: "full" | "partial" | "none";
    last_scanned_at: number | null;
    findings: SecretFinding[];
    skipped: { binary: number; oversized: number; allowlisted: number };
  }

  // --- Severity mapping ---
  export const SEVERITY_MAP: Record<string, SecretSeverity> = {
    aws: "critical", gcp: "critical", azure: "critical",
    stripe: "critical", paypal: "critical",
    openai: "high", anthropic: "high", github: "high",
    "github-v2": "high", slack: "high", twilio: "high",
    sendgrid: "high", gitlab: "high", bitbucket: "high",
    generic: "medium", jdbc: "medium",
  };

  // --- Pure helpers ---
  export function maskSecret(text: string): string {
    if (text.length < 8) return "****";
    return text.slice(0, 4) + "***" + text.slice(-4);
  }

  const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
  const CONFIG_EXTENSIONS = new Set([".env", ".yaml", ".yml", ".toml", ".ini", ".properties", ".json"]);

  export function isDocFile(filePath: string): boolean {
    return DOC_EXTENSIONS.has(extname(filePath).toLowerCase());
  }

  export function classifyContext(filePath: string): SecretContext {
    if (isTestFile(filePath)) return "test";
    if (isDocFile(filePath)) return "docs";
    const ext = extname(filePath).toLowerCase();
    if (CONFIG_EXTENSIONS.has(ext) || filePath.endsWith(".env")) return "config";
    return "production";
  }

  export function getSeverity(ruleId: string, libConfidence: "high" | "medium"): SecretSeverity {
    if (libConfidence === "medium") return "medium";
    return SEVERITY_MAP[ruleId] ?? "high";
  }

  export function isAllowlisted(lines: string[], lineIndex: number): boolean {
    const marker = "codesift:allow-secret";
    if (lines[lineIndex]?.includes(marker)) return true;
    if (lineIndex > 0 && lines[lineIndex - 1]?.includes(marker)) return true;
    return false;
  }

  export function offsetToLine(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  // --- Cache ---
  const secretCache = new Map<string, Map<string, SecretCacheEntry>>();

  export function getSecretCache(repoName: string): Map<string, SecretCacheEntry> {
    let repoCache = secretCache.get(repoName);
    if (!repoCache) {
      repoCache = new Map();
      secretCache.set(repoName, repoCache);
    }
    return repoCache;
  }

  export function resetSecretCache(repoName?: string): void {
    if (repoName) {
      secretCache.delete(repoName);
    } else {
      secretCache.clear();
    }
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `add secret-tools types, masking, severity mapping, and pure helpers`

---

### Task 5: Core scanning logic — scanFileForSecrets
**Files:** `src/tools/secret-tools.ts`, `tests/tools/secret-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 4
**Model routing:** Opus

- [ ] RED: Write tests for `scanFileForSecrets`
  ```typescript
  // Add to tests/tools/secret-tools.test.ts
  import { vi, beforeEach } from "vitest";
  import { scanFileForSecrets, resetSecretCache } from "../../src/tools/secret-tools.js";

  // Mock the scanner
  vi.mock("@sanity-labs/secret-scan", () => ({
    scan: vi.fn(() => []),
  }));

  // Mock fs
  vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
      ...actual,
      readFile: vi.fn(async () => "mock content"),
      stat: vi.fn(async () => ({ mtimeMs: 1000 })),
    };
  });

  describe("scanFileForSecrets", () => {
    beforeEach(() => {
      resetSecretCache();
      vi.clearAllMocks();
    });

    it("returns empty findings for clean file", async () => {
      const result = await scanFileForSecrets("/repo/src/app.ts", "/repo", "test-repo");
      expect(result).toEqual([]);
    });

    it("detects and masks secrets", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { rule: "openai", label: "OpenAI API Key", text: "sk-proj-abc123defghijk", confidence: "high", start: 15, end: 36 },
      ]);
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('const key = "sk-proj-abc123defghijk";');

      const result = await scanFileForSecrets("/repo/src/config.ts", "/repo", "test-repo");
      expect(result).toHaveLength(1);
      expect(result[0].match_masked).toBe("sk-p***hijk");
      expect(result[0].severity).toBe("high");
      expect(result[0].file).toBe("src/config.ts");
    });

    it("suppresses findings with codesift:allow-secret comment", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { rule: "openai", label: "OpenAI", text: "sk-proj-abc123defghijk", confidence: "high", start: 40, end: 61 },
      ]);
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('// codesift:allow-secret\nconst key = "sk-proj-abc123defghijk";');

      const result = await scanFileForSecrets("/repo/src/config.ts", "/repo", "test-repo");
      expect(result).toHaveLength(0);
    });

    it("uses cache on second call with same mtime", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      await scanFileForSecrets("/repo/src/app.ts", "/repo", "test-repo");
      await scanFileForSecrets("/repo/src/app.ts", "/repo", "test-repo");
      expect(scan).toHaveBeenCalledTimes(1);
    });

    it("re-scans when mtime changes", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      const { stat } = await import("node:fs/promises");
      await scanFileForSecrets("/repo/src/app.ts", "/repo", "test-repo");
      (stat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ mtimeMs: 2000 });
      await scanFileForSecrets("/repo/src/app.ts", "/repo", "test-repo");
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it("skips binary files", async () => {
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Buffer.from([0x00, 0x01, 0x02]).toString("utf-8"));
      const result = await scanFileForSecrets("/repo/image.png", "/repo", "test-repo");
      expect(result).toEqual([]);
    });

    it("classifies test file findings as confidence low", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { rule: "openai", label: "OpenAI", text: "sk-proj-abc123defghijk", confidence: "high", start: 0, end: 21 },
      ]);
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce("sk-proj-abc123defghijk");

      const result = await scanFileForSecrets("/repo/src/app.test.ts", "/repo", "test-repo");
      expect(result[0].confidence).toBe("low");
      expect(result[0].context).toBe("test");
    });
  });
  ```
- [ ] GREEN: Implement `scanFileForSecrets` in `src/tools/secret-tools.ts`
  ```typescript
  // Add to src/tools/secret-tools.ts
  import { scan } from "@sanity-labs/secret-scan";
  import { readFile, stat } from "node:fs/promises";
  import { relative } from "node:path";

  const MAX_FILE_SIZE = 500_000; // 500KB

  function isBinaryContent(content: string): boolean {
    const probe = content.slice(0, 512);
    return probe.includes("\0");
  }

  export async function scanFileForSecrets(
    filePath: string,
    repoRoot: string,
    repoName: string,
  ): Promise<SecretFinding[]> {
    const relPath = relative(repoRoot, filePath);
    const cache = getSecretCache(repoName);

    // Get mtime for cache check
    const fileStat = await stat(filePath);
    const mtimeMs = Math.round(fileStat.mtimeMs);

    // Cache hit?
    const cached = cache.get(relPath);
    if (cached && cached.mtime_ms === mtimeMs) {
      return cached.findings;
    }

    // Read file
    const content = await readFile(filePath, "utf-8");

    // Skip binary
    if (isBinaryContent(content)) {
      cache.set(relPath, { mtime_ms: mtimeMs, findings: [] });
      return [];
    }

    // Skip oversized
    if (content.length > MAX_FILE_SIZE) {
      cache.set(relPath, { mtime_ms: mtimeMs, findings: [] });
      return [];
    }

    // Scan
    const secrets = scan(content);
    const lines = content.split("\n");
    const context = classifyContext(relPath);

    const findings: SecretFinding[] = [];
    for (const secret of secrets) {
      const line = offsetToLine(content, secret.start);
      const lineIndex = line - 1;

      // Allowlist check
      if (isAllowlisted(lines, lineIndex)) continue;

      // Confidence: library base, CodeSift only demotes
      let confidence = secret.confidence as "high" | "medium" | "low";
      if (context === "test" || context === "docs") confidence = "low";

      findings.push({
        file: relPath,
        line,
        rule: secret.rule,
        label: secret.label,
        severity: getSeverity(secret.rule, secret.confidence as "high" | "medium"),
        confidence,
        match_masked: maskSecret(secret.text),
        context,
      });
    }

    // Verify mtime didn't change during scan (drift detection)
    const postStat = await stat(filePath).catch(() => null);
    if (postStat && Math.round(postStat.mtimeMs) !== mtimeMs) {
      return findings; // Don't cache stale results
    }

    cache.set(relPath, { mtime_ms: mtimeMs, findings });
    return findings;
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `implement scanFileForSecrets with caching, masking, and confidence classification`

---

### Task 6: AST enrichment — symbol context for findings
**Files:** `src/tools/secret-tools.ts`, `tests/tools/secret-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 5
**Model routing:** Sonnet

- [ ] RED: Write tests for symbol enrichment
  ```typescript
  // Add to tests/tools/secret-tools.test.ts
  import { enrichWithSymbolContext } from "../../src/tools/secret-tools.js";
  import type { CodeSymbol } from "../../src/types.js";

  describe("enrichWithSymbolContext", () => {
    const symbols: CodeSymbol[] = [
      { id: "test:src/config.ts:getConfig:5", repo: "test", name: "getConfig", kind: "function", file: "src/config.ts", start_line: 5, end_line: 20 },
      { id: "test:src/config.ts:API_KEY:22", repo: "test", name: "API_KEY", kind: "constant", file: "src/config.ts", start_line: 22, end_line: 22 },
    ];

    it("adds symbol_name and symbol_kind when finding is within symbol range", () => {
      const finding: SecretFinding = { file: "src/config.ts", line: 10, rule: "openai", label: "OpenAI", severity: "high", confidence: "high", match_masked: "sk-p***hijk", context: "production" };
      const enriched = enrichWithSymbolContext(finding, symbols);
      expect(enriched.symbol_name).toBe("getConfig");
      expect(enriched.symbol_kind).toBe("function");
    });

    it("leaves symbol fields undefined when no symbol matches", () => {
      const finding: SecretFinding = { file: "src/config.ts", line: 30, rule: "openai", label: "OpenAI", severity: "high", confidence: "high", match_masked: "sk-p***hijk", context: "production" };
      const enriched = enrichWithSymbolContext(finding, symbols);
      expect(enriched.symbol_name).toBeUndefined();
      expect(enriched.symbol_kind).toBeUndefined();
    });

    it("demotes confidence for symbols with placeholder names", () => {
      const testSymbols: CodeSymbol[] = [
        { id: "test:src/test.ts:TEST_KEY:1", repo: "test", name: "TEST_KEY", kind: "constant", file: "src/test.ts", start_line: 1, end_line: 1 },
      ];
      const finding: SecretFinding = { file: "src/test.ts", line: 1, rule: "openai", label: "OpenAI", severity: "high", confidence: "high", match_masked: "sk-p***hijk", context: "production" };
      const enriched = enrichWithSymbolContext(finding, testSymbols);
      expect(enriched.confidence).toBe("low");
    });
  });
  ```
- [ ] GREEN: Implement `enrichWithSymbolContext`
  ```typescript
  // Add to src/tools/secret-tools.ts
  import type { CodeSymbol } from "../types.js";

  const PLACEHOLDER_PREFIXES = ["TEST_", "FAKE_", "EXAMPLE_", "PLACEHOLDER_", "MOCK_", "DUMMY_"];

  export function enrichWithSymbolContext(
    finding: SecretFinding,
    symbols: CodeSymbol[],
  ): SecretFinding {
    const match = symbols.find(
      (s) => s.file === finding.file && s.start_line <= finding.line && s.end_line >= finding.line,
    );

    if (!match) return finding;

    const enriched = { ...finding, symbol_name: match.name, symbol_kind: match.kind };

    // Demote if enclosing symbol has a placeholder name
    if (PLACEHOLDER_PREFIXES.some((p) => match.name.toUpperCase().startsWith(p))) {
      enriched.confidence = "low";
    }

    return enriched;
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `add AST symbol enrichment for secret findings with placeholder demotion`

---

### Task 7: scan_secrets MCP tool handler
**Files:** `src/tools/secret-tools.ts`, `tests/tools/secret-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 5, Task 6
**Model routing:** Opus

- [ ] RED: Write tests for the `scanSecrets` handler
  ```typescript
  // Add to tests/tools/secret-tools.test.ts
  import { scanSecrets } from "../../src/tools/secret-tools.js";

  // Mock getCodeIndex
  vi.mock("../../src/tools/index-tools.js", () => ({
    getCodeIndex: vi.fn(async () => ({
      repo: "test-repo",
      root: "/repo",
      symbols: [],
      files: [
        { path: "src/app.ts", language: "typescript", symbol_count: 5, last_modified: Date.now(), mtime_ms: 1000 },
        { path: ".env", language: "config", symbol_count: 0, last_modified: Date.now(), mtime_ms: 1000 },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      symbol_count: 5,
    })),
  }));

  describe("scanSecrets handler", () => {
    beforeEach(() => {
      resetSecretCache();
      vi.clearAllMocks();
    });

    it("returns ScanSecretsResult with correct shape", async () => {
      const result = await scanSecrets("test-repo");
      expect(result).toHaveProperty("total_findings");
      expect(result).toHaveProperty("files_scanned");
      expect(result).toHaveProperty("scan_coverage");
      expect(result).toHaveProperty("findings");
      expect(result).toHaveProperty("skipped");
    });

    it("returns scan_coverage 'full' after scanning all files", async () => {
      const result = await scanSecrets("test-repo");
      expect(result.scan_coverage).toBe("full");
    });

    it("filters by min_confidence", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValue([
        { rule: "generic", label: "Generic", text: "abcdefghijklmnop", confidence: "medium", start: 0, end: 16 },
      ]);
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("abcdefghijklmnop");

      const result = await scanSecrets("test-repo", { min_confidence: "high" });
      expect(result.findings.every((f: SecretFinding) => f.confidence === "high")).toBe(true);
    });

    it("excludes test files when exclude_tests is true", async () => {
      const { getCodeIndex } = await import("../../src/tools/index-tools.js");
      (getCodeIndex as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        repo: "test-repo", root: "/repo", symbols: [], created_at: Date.now(), updated_at: Date.now(), symbol_count: 0,
        files: [
          { path: "src/app.test.ts", language: "typescript", symbol_count: 2, last_modified: Date.now(), mtime_ms: 1000 },
        ],
      });
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValue([
        { rule: "openai", label: "OpenAI", text: "sk-proj-abc123defghijk", confidence: "high", start: 0, end: 21 },
      ]);
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("sk-proj-abc123defghijk");

      const result = await scanSecrets("test-repo", { exclude_tests: true });
      expect(result.findings).toHaveLength(0);
    });
  });
  ```
- [ ] GREEN: Implement `scanSecrets` handler
  ```typescript
  // Add to src/tools/secret-tools.ts
  import { getCodeIndex } from "./index-tools.js";
  import { join } from "node:path";
  import picomatch from "picomatch";

  const SKIP_PATTERNS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.min.js", "*.min.css"];
  const SKIP_DIRS = ["audits/artifacts/"];
  const MIN_LINE_LENGTH_FOR_MINIFIED = 10_000; // skip single-line files >10KB

  export async function scanSecrets(
    repoName: string,
    options?: {
      file_pattern?: string;
      min_confidence?: "high" | "medium" | "low";
      exclude_tests?: boolean;
      severity?: SecretSeverity;
    },
  ): Promise<ScanSecretsResult> {
    const index = await getCodeIndex(repoName);
    if (!index) throw new Error(`Repository "${repoName}" not found or not indexed`);

    const excludeTests = options?.exclude_tests ?? true;
    const minConfidence = options?.min_confidence ?? "medium";
    const confidenceOrder = { high: 3, medium: 2, low: 1 };

    let filesScanned = 0;
    let skipped = { binary: 0, oversized: 0, allowlisted: 0 };
    const allFindings: SecretFinding[] = [];

    for (const fileEntry of index.files) {
      // Skip patterns
      if (SKIP_PATTERNS.some((p) => fileEntry.path.endsWith(p) || matchGlob(fileEntry.path, p))) continue;
      if (SKIP_DIRS.some((d) => fileEntry.path.startsWith(d))) continue;

      // File pattern filter
      if (options?.file_pattern && !picomatch.isMatch(fileEntry.path, options.file_pattern)) continue;

      const fullPath = join(index.root, fileEntry.path);

      try {
        const findings = await scanFileForSecrets(fullPath, index.root, repoName);
        filesScanned++;

        // Enrich with symbol context
        const fileSymbols = index.symbols.filter((s) => s.file === fileEntry.path);
        const enriched = findings.map((f) => enrichWithSymbolContext(f, fileSymbols));

        // Apply filters
        for (const finding of enriched) {
          if (excludeTests && finding.context === "test") continue;
          if (confidenceOrder[finding.confidence] < confidenceOrder[minConfidence]) continue;
          if (options?.severity && confidenceOrder[finding.severity as keyof typeof confidenceOrder] < confidenceOrder[options.severity]) continue;
          allFindings.push(finding);
        }
      } catch {
        // Skip unreadable files, continue scanning
        filesScanned++;
      }
    }

    const filesWithSecrets = new Set(allFindings.map((f) => f.file)).size;
    const cache = getSecretCache(repoName);
    const totalIndexed = index.files.length;
    const cachedCount = cache.size;
    const coverage = cachedCount === 0 ? "none" as const
      : cachedCount >= totalIndexed ? "full" as const
      : "partial" as const;

    return {
      total_findings: allFindings.length,
      files_scanned: filesScanned,
      files_with_secrets: filesWithSecrets,
      scan_coverage: coverage,
      last_scanned_at: Date.now(),
      findings: allFindings,
      skipped,
    };
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `implement scan_secrets MCP tool handler with filtering and symbol enrichment`

---

### Task 8: Register scan_secrets in TOOL_DEFINITIONS
**Files:** `src/register-tools.ts`
**Complexity:** standard
**Dependencies:** Task 7
**Model routing:** Sonnet

- [ ] RED: Write a test that verifies tool registration
  ```typescript
  // Add to tests/tools/secret-tools.test.ts or tests/integration/tools.test.ts
  describe("scan_secrets tool registration", () => {
    it("is registered in TOOL_DEFINITIONS", async () => {
      const { TOOL_DEFINITIONS } = await import("../../src/register-tools.js");
      const scanTool = TOOL_DEFINITIONS.find((t: { name: string }) => t.name === "scan_secrets");
      expect(scanTool).toBeDefined();
      expect(scanTool!.name).toBe("scan_secrets");
    });
  });
  ```
- [ ] GREEN: Add the tool definition to `src/register-tools.ts`
  ```typescript
  // Add to TOOL_DEFINITIONS array (before the closing ]; of the array)
  // Import at top:
  import { scanSecrets } from "./tools/secret-tools.js";

  // Tool definition:
  {
    name: "scan_secrets",
    description: "Scan repository for hardcoded secrets (API keys, tokens, passwords, connection strings). Returns masked findings with severity, confidence, and AST context. Uses ~1,100 detection rules.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level (default: medium)"),
      exclude_tests: z.boolean().optional().describe("Exclude test file findings (default: true)"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Minimum severity level"),
    },
    handler: async (args) => scanSecrets(
      args.repo as string,
      {
        file_pattern: args.file_pattern as string | undefined,
        min_confidence: args.min_confidence as "high" | "medium" | "low" | undefined,
        exclude_tests: args.exclude_tests as boolean | undefined,
        severity: args.severity as SecretSeverity | undefined,
      },
    ),
  },
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `register scan_secrets in TOOL_DEFINITIONS for MCP exposure`

---

### Task 9: Watcher integration — eager scan on file change
**Files:** `src/tools/index-tools.ts`, `tests/tools/secret-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 3, Task 5
**Model routing:** Sonnet

- [ ] RED: Write test for cache invalidation on file change
  ```typescript
  // Add to tests/tools/secret-tools.test.ts
  import { onFileChanged, onFileDeleted, resetSecretCache, getSecretCache } from "../../src/tools/secret-tools.js";

  describe("watcher integration", () => {
    beforeEach(() => resetSecretCache());

    it("onFileChanged scans the file and populates cache", async () => {
      const { scan } = await import("@sanity-labs/secret-scan");
      (scan as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      await onFileChanged("/repo/src/app.ts", "/repo", "test-repo");
      const cache = getSecretCache("test-repo");
      expect(cache.has("src/app.ts")).toBe(true);
    });

    it("onFileDeleted removes file from cache", () => {
      const cache = getSecretCache("test-repo");
      cache.set("src/deleted.ts", { mtime_ms: 1000, findings: [] });
      onFileDeleted("src/deleted.ts", "test-repo");
      expect(cache.has("src/deleted.ts")).toBe(false);
    });
  });
  ```
- [ ] GREEN: Add `onFileChanged` and `onFileDeleted` exports, then hook into `index-tools.ts`
  ```typescript
  // Add to src/tools/secret-tools.ts
  export async function onFileChanged(
    filePath: string,
    repoRoot: string,
    repoName: string,
  ): Promise<void> {
    try {
      await scanFileForSecrets(filePath, repoRoot, repoName);
    } catch {
      // Non-critical — don't break indexing if scan fails
    }
  }

  export function onFileDeleted(relativeFile: string, repoName: string): void {
    const cache = getSecretCache(repoName);
    cache.delete(relativeFile);
  }
  ```

  ```typescript
  // In src/tools/index-tools.ts — modify handleFileChange (line 576):
  // Add import at top:
  import { onFileChanged as scanOnChanged, onFileDeleted as scanOnDeleted } from "./secret-tools.js";

  // In handleFileChange, BEFORE the if (!result) return:
  async function handleFileChange(...): Promise<void> {
    const fullPath = join(repoRoot, relativeFile);
    // Eager secret scan — runs even for config files that parseOneFile might skip
    scanOnChanged(fullPath, repoRoot, repoName).catch(() => {}); // fire-and-forget
    const result = await parseOneFile(fullPath, repoRoot, repoName);
    if (!result) return;
    // ... rest unchanged
  }

  // In handleFileDelete, add after embeddingCaches.delete:
  scanOnDeleted(relativeFile, repoName);
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools.test.ts`
  Expected: All tests pass
- [ ] Commit: `integrate eager secret scanning with file watcher on change/delete`

---

### Task 10: Inline warnings in index_file/index_folder responses
**Files:** `src/tools/index-tools.ts`, `tests/integration/config-files.test.ts`
**Complexity:** standard
**Dependencies:** Task 9
**Model routing:** Sonnet

- [ ] RED: Write integration test for inline warnings
  ```typescript
  // Add to tests/integration/config-files.test.ts
  it("index_file response includes secrets warning when secrets found", async () => {
    await writeFile(join(tempDir, "leaked.ts"), 'const key = "sk-proj-real1234567890abcdefghij";');
    const result = await indexFile(join(tempDir, "leaked.ts"));
    // The response should contain a secrets warning
    expect(JSON.stringify(result)).toContain("secret");
  });
  ```
- [ ] GREEN: Append secrets summary to `indexFile` and `indexFolder` responses
  ```typescript
  // In src/tools/index-tools.ts — modify indexFile response (around line 700):
  // After the existing return object, add a secrets_warning field:
  import { getSecretCache } from "./secret-tools.js";

  // In the indexFile function, after the file is indexed:
  const secretFindings = getSecretCache(repoName).get(relPath);
  const secretsWarning = secretFindings?.findings.length
    ? `⚠ ${secretFindings.findings.length} potential secret(s) detected`
    : undefined;

  return {
    repo: repoName,
    file: relPath,
    symbol_count: result.symbols.length,
    duration_ms: Date.now() - startTime,
    ...(secretsWarning && { secrets_warning: secretsWarning }),
  };
  ```
- [ ] Verify: `npx vitest run tests/integration/config-files.test.ts`
  Expected: All tests pass
- [ ] Commit: `add inline secrets warnings to index_file and index_folder responses`

---

### Task 11: Config flag, usage tracking, and server-helpers
**Files:** `src/config.ts`, `src/storage/usage-tracker.ts`, `src/server-helpers.ts`
**Complexity:** standard
**Dependencies:** Task 8
**Model routing:** Sonnet

- [ ] RED: Write tests for config flag and usage tracking
  ```typescript
  // tests/tools/secret-tools-config.test.ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { resetConfigCache, loadConfig } from "../../src/config.js";

  describe("secretScanEnabled config", () => {
    beforeEach(() => resetConfigCache());
    afterEach(() => {
      delete process.env.CODESIFT_SECRET_SCAN;
      resetConfigCache();
    });

    it("defaults to true when env not set", () => {
      const config = loadConfig();
      expect(config.secretScanEnabled).toBe(true);
    });

    it("can be disabled via CODESIFT_SECRET_SCAN=false", () => {
      process.env.CODESIFT_SECRET_SCAN = "false";
      resetConfigCache();
      const config = loadConfig();
      expect(config.secretScanEnabled).toBe(false);
    });
  });
  ```
- [ ] GREEN: Implement the three modifications
  ```typescript
  // 1. src/config.ts — add to Config interface and loadConfig:
  secretScanEnabled: boolean;
  // In loadConfig():
  secretScanEnabled: process.env.CODESIFT_SECRET_SCAN !== "false",

  // 2. src/storage/usage-tracker.ts — add to TOOL_ARG_FIELDS:
  scan_secrets: ["repo", "file_pattern", "min_confidence", "severity"],

  // 3. src/server-helpers.ts — add to SAVINGS_MULTIPLIER:
  scan_secrets: 1.2,
  // Note: wrapTool cache is safe for scan_secrets because all values
  // are masked before SecretFinding is created. No cache bypass needed.
  ```
- [ ] Verify: `npx vitest run tests/tools/secret-tools-config.test.ts`
  Expected: All tests pass
- [ ] Commit: `add secretScanEnabled config flag, usage tracking, and savings multiplier`
