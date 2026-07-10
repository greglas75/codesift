import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextMatch } from "../../src/types.js";

const semanticMocks = vi.hoisted(() => ({
  handleSemanticQuery: vi.fn(),
}));

vi.mock("../../src/retrieval/semantic-handlers.js", () => ({
  handleSemanticQuery: semanticMocks.handleSemanticQuery,
}));

interface FallbackFixture {
  repo: string;
  searchText: typeof import("../../src/tools/search-tools.js").searchText;
  cleanup: () => Promise<void>;
}

async function loadNodeFallbackFixture(): Promise<FallbackFixture> {
  const originalDataDir = process.env["CODESIFT_DATA_DIR"];
  const dataDir = await mkdtemp(join(tmpdir(), "codesift-search-characterization-data-"));
  const root = await mkdtemp(join(tmpdir(), "codesift-search-characterization-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;

  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      execFileSync: vi.fn(() => {
        throw new Error("child process unavailable in Node fallback characterization");
      }),
    };
  });

  const { resetConfigCache } = await import("../../src/config.js");
  const {
    indexFolder,
    resetIndexFolderRedundancyForTesting,
    stopAllWatchersForTesting,
  } = await import("../../src/tools/index-tools.js");
  resetConfigCache();
  resetIndexFolderRedundancyForTesting();

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/example.ts"),
    [
      "const before = 1;",
      "const targetValue = 'needle';",
      "const after = 2;",
      "",
    ].join("\n"),
  );
  const indexed = await indexFolder(root, { watch: false });
  const { searchText } = await import("../../src/tools/search-tools.js");

  return {
    repo: indexed.repo,
    searchText,
    cleanup: async () => {
      await stopAllWatchersForTesting();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (originalDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
      else process.env["CODESIFT_DATA_DIR"] = originalDataDir;
      resetConfigCache();
      vi.doUnmock("node:child_process");
      vi.resetModules();
    },
  };
}

afterEach(() => {
  semanticMocks.handleSemanticQuery.mockReset();
});

describe("search tools characterization", () => {
  it("delegates semantic options and serializes non-string results", async () => {
    const semanticData = { matches: [{ file: "src/example.ts", score: 0.75 }] };
    semanticMocks.handleSemanticQuery
      .mockResolvedValueOnce({ data: semanticData })
      .mockResolvedValueOnce({ data: "already formatted" });
    const { semanticSearch } = await import("../../src/tools/search-tools.js");

    await expect(semanticSearch("local/example", "find target", {
      top_k: 7,
      file_pattern: "src/**/*.ts",
      exclude_tests: true,
      rerank: false,
    })).resolves.toBe(JSON.stringify(semanticData));
    await expect(semanticSearch("local/example", "find target")).resolves.toBe("already formatted");
    expect(semanticMocks.handleSemanticQuery).toHaveBeenNthCalledWith(1, "local/example", {
      type: "semantic",
      query: "find target",
      top_k: 7,
      file_filter: "src/**/*.ts",
      exclude_tests: true,
      rerank: false,
    });
    expect(semanticMocks.handleSemanticQuery).toHaveBeenNthCalledWith(2, "local/example", {
      type: "semantic",
      query: "find target",
      top_k: undefined,
      file_filter: undefined,
      exclude_tests: undefined,
      rerank: undefined,
    });
  });

  it("searches with the Node fallback when ripgrep is unavailable", async () => {
    const fixture = await loadNodeFallbackFixture();
    try {
      const result = await fixture.searchText(fixture.repo, "targetValue\\s*=", {
        regex: true,
        file_pattern: "src/*.ts",
        context_lines: 1,
        group_by_file: false,
        auto_group: false,
      });

      expect(result).toEqual([{
        file: "src/example.ts",
        line: 2,
        content: "const targetValue = 'needle';",
        context_before: ["const before = 1;"],
        context_after: ["const after = 2;"],
      } satisfies TextMatch]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unsafe regular expressions before the fallback scan", async () => {
    const fixture = await loadNodeFallbackFixture();
    try {
      await expect(fixture.searchText(fixture.repo, "(a+)+", {
        regex: true,
        file_pattern: "src/*.ts",
      })).rejects.toThrow("Regex pattern rejected: potential catastrophic backtracking (ReDoS)");
    } finally {
      await fixture.cleanup();
    }
  });
});
