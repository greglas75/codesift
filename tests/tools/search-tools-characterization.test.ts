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
  searchSymbols: typeof import("../../src/tools/search-tools.js").searchSymbols;
  cleanup: () => Promise<void>;
}

interface FixtureOptions {
  source?: string;
  additionalFiles?: Record<string, string>;
}

const DEFAULT_SOURCE = [
  "const before = 1;",
  "const targetValue = 'needle';",
  "const after = 2;",
  "",
].join("\n");

async function loadNodeFallbackFixture(options: FixtureOptions = {}): Promise<FallbackFixture> {
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
      execFile: vi.fn((
        _command: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error("child process unavailable in Node fallback characterization"), "", "");
        return {};
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
    options.source ?? DEFAULT_SOURCE,
  );
  for (const [relativePath, content] of Object.entries(options.additionalFiles ?? {})) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  const indexed = await indexFolder(root, { watch: false });
  const { searchSymbols, searchText } = await import("../../src/tools/search-tools.js");

  return {
    repo: indexed.repo,
    searchSymbols,
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

interface RipgrepBehavior {
  error?: boolean;
  delayMs?: number;
  wallClockMs?: number;
  reportedRelativePath?: string;
}

async function loadRipgrepFixture(behavior: RipgrepBehavior = {}): Promise<FallbackFixture> {
  const originalDataDir = process.env["CODESIFT_DATA_DIR"];
  const originalWallClock = process.env["CODESIFT_SEARCH_TEXT_CAP_MS"];
  const dataDir = await mkdtemp(join(tmpdir(), "codesift-ripgrep-characterization-data-"));
  const root = await mkdtemp(join(tmpdir(), "codesift-ripgrep-characterization-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  if (behavior.wallClockMs !== undefined) {
    process.env["CODESIFT_SEARCH_TEXT_CAP_MS"] = String(behavior.wallClockMs);
  }
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/example.ts"), DEFAULT_SOURCE);
  const reportedPath = join(root, behavior.reportedRelativePath ?? "src/example.ts");
  const jsonEvent = (type: "context" | "match", line: number, text: string): string => JSON.stringify({
    type,
    data: {
      path: { text: reportedPath },
      lines: { text: `${text}\n` },
      line_number: line,
    },
  });
  const stdout = [
    jsonEvent("context", 1, "const before = 1;"),
    jsonEvent("match", 2, "const targetValue = 'needle';"),
    jsonEvent("context", 3, "const after = 2;"),
  ].join("\n");

  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      execFileSync: vi.fn((command: string, args: string[], options: object) => {
        if (command !== "rg") return Reflect.apply(actual.execFileSync, actual, [command, args, options]);
        if (args[0] === "--version") return "ripgrep 14";
        if (behavior.error) throw Object.assign(new Error("ripgrep failed"), { status: 2 });
        return stdout;
      }),
      execFile: vi.fn((
        _command: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args[0] === "--version") {
          callback(null, "ripgrep 14", "");
          return {};
        }
        setTimeout(() => {
          if (behavior.error) callback(Object.assign(new Error("ripgrep failed"), { code: 2 }), "", "");
          else callback(null, stdout, "");
        }, behavior.delayMs ?? 0);
        return {};
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
  const indexed = await indexFolder(root, { watch: false });
  const { searchSymbols, searchText } = await import("../../src/tools/search-tools.js");

  return {
    repo: indexed.repo,
    searchSymbols,
    searchText,
    cleanup: async () => {
      await stopAllWatchersForTesting();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (originalDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
      else process.env["CODESIFT_DATA_DIR"] = originalDataDir;
      if (originalWallClock === undefined) delete process.env["CODESIFT_SEARCH_TEXT_CAP_MS"];
      else process.env["CODESIFT_SEARCH_TEXT_CAP_MS"] = originalWallClock;
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

  it("clamps externally supplied symbol and text result limits", async () => {
    const symbolSource = Array.from(
      { length: 1001 },
      (_, index) => `export function symbol${index}(): number { return ${index}; }`,
    ).join("\n");
    const symbolFixture = await loadNodeFallbackFixture({ source: symbolSource });
    try {
      const symbols = await symbolFixture.searchSymbols(symbolFixture.repo, "", {
        top_k: Number.POSITIVE_INFINITY,
        include_source: false,
      });
      expect.soft(symbols).toHaveLength(1000);
    } finally {
      await symbolFixture.cleanup();
    }

    const textSource = Array.from({ length: 1001 }, (_, index) => `// needle value ${index}`).join("\n");
    const textFixture = await loadNodeFallbackFixture({ source: textSource });
    try {
      const matches = await textFixture.searchText(textFixture.repo, "needle value", {
        max_results: Number.POSITIVE_INFINITY,
        group_by_file: false,
        auto_group: false,
      });
      expect.soft(matches).toHaveLength(1000);
    } finally {
      await textFixture.cleanup();
    }
  });

  it("clamps invalid and oversized source character limits", async () => {
    const source = `export function targetValue(): string { return "${"x".repeat(6_000)}"; }`;
    const fixture = await loadNodeFallbackFixture({ source });
    try {
      const oversized = await fixture.searchSymbols(fixture.repo, "targetValue", {
        top_k: 1,
        include_source: true,
        source_chars: Number.POSITIVE_INFINITY,
      });
      expect(oversized[0]?.symbol.source).toHaveLength(5_003);

      const negative = await fixture.searchSymbols(fixture.repo, "targetValue", {
        top_k: 1,
        include_source: true,
        source_chars: -100,
      });
      expect(negative[0]?.symbol.source).toHaveLength(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("clamps context lines to a bounded window", async () => {
    const source = [
      ...Array.from({ length: 25 }, (_, index) => `// before ${index}`),
      "// target marker",
      ...Array.from({ length: 25 }, (_, index) => `// after ${index}`),
    ].join("\n");
    const fixture = await loadNodeFallbackFixture({ source });
    try {
      const result = await fixture.searchText(fixture.repo, "target marker", {
        context_lines: Number.POSITIVE_INFINITY,
        group_by_file: false,
        auto_group: false,
      }) as TextMatch[];
      expect(result[0]?.context_before).toHaveLength(20);
      expect(result[0]?.context_after).toHaveLength(20);
    } finally {
      await fixture.cleanup();
    }
  });

  it("searches all files for identifier usages instead of returning a BM25 shortlist", async () => {
    const fixture = await loadNodeFallbackFixture({
      additionalFiles: { "docs/notes.md": "The targetValue constant is part of the public example.\n" },
    });
    try {
      const result = await fixture.searchText(fixture.repo, "targetValue") as TextMatch[];
      expect(result.some((match) => match.file === "docs/notes.md")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("attaches ripgrep context even when output contains one block", async () => {
    const fixture = await loadRipgrepFixture();
    try {
      const result = await fixture.searchText(fixture.repo, "targetValue", {
        context_lines: 1,
        group_by_file: false,
        auto_group: false,
      }) as TextMatch[];
      expect(result[0]?.context_before).toEqual(["const before = 1;"]);
      expect(result[0]?.context_after).toEqual(["const after = 2;"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves paths containing colon-number segments in ripgrep output", async () => {
    const fixture = await loadRipgrepFixture({ reportedRelativePath: "src/foo:12/example.ts" });
    try {
      const result = await fixture.searchText(fixture.repo, "targetValue", {
        group_by_file: false,
        auto_group: false,
      }) as TextMatch[];
      expect(result[0]?.file).toBe("src/foo:12/example.ts");
      expect(result[0]?.line).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("applies explicit grouped and compact shapes after ranking", async () => {
    const fixture = await loadNodeFallbackFixture();
    try {
      const grouped = await fixture.searchText(fixture.repo, "targetValue", {
        ranked: true,
        group_by_file: true,
      });
      expect(grouped[0]).toMatchObject({ file: "src/example.ts", count: 1 });

      const compact = await fixture.searchText(fixture.repo, "targetValue", {
        ranked: true,
        compact: true,
      });
      expect(compact).toContain("src/example.ts:2:");
    } finally {
      await fixture.cleanup();
    }
  });

  it("falls back to the Node scanner when ripgrep execution fails", async () => {
    const fixture = await loadRipgrepFixture({ error: true });
    try {
      const result = await fixture.searchText(fixture.repo, "targetValue", {
        file_pattern: "src/*.ts",
        group_by_file: false,
        auto_group: false,
      }) as TextMatch[];
      expect(result.some((match) => match.content.includes("targetValue"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns timeout sentinels matching compact and grouped overloads", async () => {
    vi.useFakeTimers();
    const fixture = await loadRipgrepFixture({ delayMs: 25, wallClockMs: 5 });
    try {
      const compactPromise = fixture.searchText(fixture.repo, "targetValue", { compact: true });
      await vi.advanceTimersByTimeAsync(30);
      await expect(compactPromise).resolves.toContain("search exceeded 5ms");

      const groupedPromise = fixture.searchText(fixture.repo, "targetValue", { group_by_file: true });
      await vi.advanceTimersByTimeAsync(30);
      const grouped = await groupedPromise;
      expect(grouped[0]?.first_match).toContain("search exceeded 5ms");
    } finally {
      vi.useRealTimers();
      await fixture.cleanup();
    }
  });
});
