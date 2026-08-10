import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeIndex, FileEntry } from "../../src/types.js";

const { getCodeIndexMock, detectFrameworksMock, extractApiContractMock } = vi.hoisted(() => ({
  getCodeIndexMock: vi.fn(),
  detectFrameworksMock: vi.fn(),
  extractApiContractMock: vi.fn(),
}));

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: getCodeIndexMock,
}));

vi.mock("../../src/utils/framework-detect.js", () => ({
  detectFrameworks: detectFrameworksMock,
}));

vi.mock("../../src/tools/hono-api-contract.js", () => ({
  extractApiContract: extractApiContractMock,
}));

import { defaultRepoResolver } from "../../src/tools/cross-repo-contract-resolver.js";

function makeIndex(root: string, paths: string[]): CodeIndex {
  const files: FileEntry[] = paths.map((path) => ({
    path,
    language: path.endsWith(".ts") ? "typescript" : "text",
    symbol_count: 0,
    last_modified: 0,
  }));
  return {
    repo: "sample",
    root,
    symbols: [],
    files,
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: files.length,
  };
}

describe("defaultRepoResolver", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    fixtureRoot = await mkdtemp(join(tmpdir(), "cross-repo-resolver-"));
    detectFrameworksMock.mockReturnValue(new Set());
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("marks a repo without an index as unindexed", async () => {
    getCodeIndexMock.mockResolvedValue(undefined);

    await expect(defaultRepoResolver("missing")).resolves.toEqual({
      producers: [],
      consumers: [],
      indexed: false,
    });
  });

  it("runs the Hono producer adapter when Hono is detected", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex(fixtureRoot, []));
    detectFrameworksMock.mockReturnValue(new Set(["hono"]));
    extractApiContractMock.mockResolvedValue({
      summary: [
        {
          path: "/users/:id",
          method: "get",
          source: "explicit",
          file: "src/routes/users.ts",
        },
      ],
    });

    const result = await defaultRepoResolver("api");

    expect(extractApiContractMock).toHaveBeenCalledWith("api", undefined, "summary");
    expect(result.producers).toEqual([
      {
        repo: "api",
        method: "GET",
        path: "/users/:id",
        normalized_path: "/users/{param}",
        file: "src/routes/users.ts",
      },
    ]);
  });

  it("scans every supported source file across consumer batches and ignores other extensions", async () => {
    const sourcePaths = Array.from({ length: 17 }, (_, i) => `client-${i}.ts`);
    for (const [i, path] of sourcePaths.entries()) {
      await writeFile(join(fixtureRoot, path), `fetch("/endpoint-${i}")`, "utf-8");
    }
    await writeFile(join(fixtureRoot, "notes.txt"), `fetch("/ignored")`, "utf-8");
    getCodeIndexMock.mockResolvedValue(makeIndex(fixtureRoot, [...sourcePaths, "notes.txt"]));

    const result = await defaultRepoResolver("web");

    expect(result.consumers).toHaveLength(17);
    expect(result.consumers.map((call) => call.url_prefix)).toEqual(
      sourcePaths.map((_, i) => `/endpoint-${i}`),
    );
    expect(result.consumers.every((call) => call.repo === "web")).toBe(true);
  });

  it("warns when an indexed consumer file cannot be read", async () => {
    getCodeIndexMock.mockResolvedValue(makeIndex(fixtureRoot, ["missing.ts"]));

    const result = await defaultRepoResolver("web");

    expect(result.consumers).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/repo "web" consumer scan failed for "missing\.ts"/),
    ]);
  });
});
