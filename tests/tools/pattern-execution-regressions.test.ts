import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCodeIndex, indexFolder } from "../../src/tools/index-tools.js";
import { BUILTIN_PATTERNS, searchPatterns } from "../../src/tools/pattern-tools.js";
import { resolveIndexedFilePath } from "../../src/tools/patterns/execution.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string | undefined;

afterEach(async () => {
  for (const name of [
    "__regression-test-exclusion",
    "__regression-file-scan",
    "__regression-global-regex",
    "__regression-symlink",
  ]) delete BUILTIN_PATTERNS[name];
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  tmpDir = undefined;
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-pattern-regression-"));
  const project = join(tmpDir, "project");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(project, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await indexFolder(project, { watch: false });
  return "local/project";
}

describe("pattern execution regression guards", () => {
  it("excludes test files from file-level scans unless include_tests is true", async () => {
    BUILTIN_PATTERNS["__regression-test-exclusion"] = {
      regex: /test-only/,
      description: "regression test-only marker",
      fileIncludePattern: /\.ts$/,
    };
    const repo = await createIndexedFixture({
      "src/only.test.ts": "export const marker = \"test-only\";\n",
      "src/production.ts": "export const marker = \"production\";\n",
    });

    const productionOnly = await searchPatterns(repo, "__regression-test-exclusion");
    const withTests = await searchPatterns(repo, "__regression-test-exclusion", { include_tests: true });

    expect(productionOnly.matches.some((match) => match.file.endsWith("only.test.ts"))).toBe(false);
    expect(withTests.matches.some((match) => match.file.endsWith("only.test.ts"))).toBe(true);
  });

  it("does not suppress the full-file scan after a symbol match", async () => {
    BUILTIN_PATTERNS["__regression-file-scan"] = {
      regex: /fileLevelOnlyMarker|needle/,
      description: "regression file scan marker",
      fileIncludePattern: /\.ts$/,
    };
    const repo = await createIndexedFixture({
      "src/file-scan.ts": "// fileLevelOnlyMarker example\nimport { fileLevelOnlyMarker } from \"marker\";\nexport const needle = \"needle\";\n",
    });

    const result = await searchPatterns(repo, "__regression-file-scan", { include_tests: true });

    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        context: expect.stringContaining("fileLevelOnlyMarker"),
        start_line: 2,
      }),
    ]));
  });

  it("resets global regex state for every indexed symbol", async () => {
    BUILTIN_PATTERNS["__regression-global-regex"] = {
      regex: /needle/g,
      description: "regression global regex marker",
    };
    const repo = await createIndexedFixture({
      "src/first.ts": "export const first = \"needle\";\n",
      "src/second.ts": "export const second = \"needle\";\n",
    });

    const result = await searchPatterns(repo, "__regression-global-regex");

    expect(new Set(result.matches.map((match) => match.file))).toEqual(new Set([
      "src/first.ts",
      "src/second.ts",
    ]));
  });

  it("rejects non-positive and non-finite max_results values", async () => {
    const repo = await createIndexedFixture({ "src/sample.ts": "console.log(\"sample\");\n" });

    await expect(searchPatterns(repo, "console-log", { max_results: 0 })).rejects.toThrow("max_results");
    await expect(searchPatterns(repo, "console-log", { max_results: Number.NaN })).rejects.toThrow("max_results");
  });

  it("caps oversized max_results values", async () => {
    const source = Array.from({ length: 1005 }, (_, index) => `export const item${index} = "needle";`).join("\n");
    const repo = await createIndexedFixture({ "src/many-symbols.ts": source });

    const result = await searchPatterns(repo, "needle", { max_results: Number.MAX_SAFE_INTEGER });

    expect(result.matches).toHaveLength(1000);
  });

  it("keeps indexed file reads inside the repository root", () => {
    expect(resolveIndexedFilePath("/repo", "src/file.ts")).toBe("/repo/src/file.ts");
    expect(resolveIndexedFilePath("/repo", "../outside.txt")).toBeUndefined();
    expect(resolveIndexedFilePath("/repo", "/outside.txt")).toBeUndefined();
    expect(resolveIndexedFilePath("/repo", "C:\\outside.txt")).toBeUndefined();
    expect(resolveIndexedFilePath("/repo", "C:outside.txt")).toBeUndefined();
    expect(resolveIndexedFilePath("/repo", "\\\\server\\outside.txt")).toBeUndefined();
  });

  it("skips an indexed symlink that resolves outside the repository", async () => {
    BUILTIN_PATTERNS["__regression-symlink"] = {
      regex: /symlink-escape-marker/,
      description: "regression symlink boundary marker",
      fileIncludePattern: /\.ts$/,
    };
    const repo = await createIndexedFixture({ "src/placeholder.ts": "export const ok = true;\n" });
    const outsidePath = join(tmpDir!, "outside.ts");
    const linkedPath = join(tmpDir!, "project", "src", "linked.ts");
    await writeFile(outsidePath, "export const marker = \"symlink-escape-marker\";\n");

    try {
      await symlink(outsidePath, linkedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return;
      throw error;
    }

    const index = await getCodeIndex(repo);
    expect(index).not.toBeNull();
    index!.files.push({
      path: "src/linked.ts",
      language: "typescript",
      symbol_count: 0,
      last_modified: Date.now(),
    });

    const result = await searchPatterns(repo, "__regression-symlink", { include_tests: true });

    expect(result.matches).toHaveLength(0);
  });
});
