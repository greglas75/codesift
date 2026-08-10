import { describe, expect, it, vi } from "vitest";
import * as parserManager from "../../src/parser/parser-manager.js";
import { resetParseCache } from "../../src/parser/parse-cache.js";
import { createEdgeAccumulator } from "../../src/utils/import-graph/edge-accumulator.js";
import {
  collectSourceEdges,
  type SourceEdgeContext,
} from "../../src/utils/import-graph/source-edge-collector.js";
import { NULL_RESOLVER } from "../../src/utils/import-graph/workspace-alias.js";
import type { CodeIndex } from "../../src/types.js";

function makeIndex(paths: string[]): CodeIndex {
  return {
    repo: "test/import-graph-internals",
    root: "/tmp/import-graph-internals",
    symbols: [],
    files: paths.map((path) => ({
      path,
      language: path.split(".").at(-1) ?? "unknown",
      symbol_count: 0,
      last_modified: 0,
    })),
  };
}

function makeContext(
  index: CodeIndex,
  overrides: Partial<SourceEdgeContext> = {},
): SourceEdgeContext {
  return {
    index,
    normalizedPaths: new Map(),
    kotlinFilesByBasename: new Map(),
    workspaceResolver: NULL_RESOLVER,
    python: { disabled: true, indexedFiles: new Set(), srcLayout: null },
    addEdge: vi.fn(),
    ...overrides,
  };
}

describe("import edge accumulator", () => {
  it("deduplicates an edge and upgrades a type-only import to runtime", () => {
    const accumulator = createEdgeAccumulator();

    accumulator.add("src/a.ts", "src/b.ts", { type_only: true });
    accumulator.add("src/a.ts", "src/b.ts");

    expect(accumulator.edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", type_only: false },
    ]);
  });
});

describe("collectSourceEdges fallback and dispatch contracts", () => {
  it("falls back to regex imports when the TypeScript parser is unavailable", async () => {
    const parserSpy = vi.spyOn(parserManager, "getParser").mockResolvedValueOnce(null);
    const addEdge = vi.fn();
    const index = makeIndex(["src/main.ts", "src/dep.ts"]);
    const context = makeContext(index, {
      normalizedPaths: new Map([["src/dep", "src/dep.ts"]]),
      addEdge,
    });

    try {
      await collectSourceEdges("src/main.ts", 'import { dep } from "./dep.js";', context);
      expect(addEdge).toHaveBeenCalledWith("src/main.ts", "src/dep.ts");
    } finally {
      parserSpy.mockRestore();
    }
  });

  it("does not run regex fallback after successful type-only AST extraction", async () => {
    resetParseCache();
    const accumulator = createEdgeAccumulator();
    const index = makeIndex(["src/main.ts", "src/dep.ts"]);
    const context = makeContext(index, {
      normalizedPaths: new Map([["src/dep", "src/dep.ts"]]),
      addEdge: accumulator.add,
    });

    await collectSourceEdges(
      "src/main.ts",
      'import type { Dep } from "./dep.js";',
      context,
    );

    expect(accumulator.edges).toEqual([
      { from: "src/main.ts", to: "src/dep.ts", type_only: true },
    ]);
  });

  it("resolves bare workspace imports from Astro sources", async () => {
    const addEdge = vi.fn();
    const resolve = vi.fn().mockReturnValue("packages/shared/src/index.ts");
    const index = makeIndex(["src/Page.astro", "packages/shared/src/index.ts"]);
    const context = makeContext(index, {
      workspaceResolver: { resolve },
      addEdge,
    });

    await collectSourceEdges(
      "src/Page.astro",
      'import { shared } from "@org/shared";',
      context,
    );

    expect(resolve).toHaveBeenCalledWith("@org/shared", "src/Page.astro");
    expect(addEdge).toHaveBeenCalledWith(
      "src/Page.astro",
      "packages/shared/src/index.ts",
    );
  });

  it("waits for Python edge collection before resolving", async () => {
    let releaseParser!: (parser: null) => void;
    const parserResult = new Promise<null>((resolve) => {
      releaseParser = resolve;
    });
    const parserSpy = vi.spyOn(parserManager, "getParser").mockReturnValueOnce(parserResult);
    const index = makeIndex(["src/main.py"]);
    const context = makeContext(index, {
      python: { disabled: false, indexedFiles: new Set(["src/main.py"]), srcLayout: null },
    });
    let settled = false;

    try {
      const pending = collectSourceEdges("src/main.py", "", context);
      void pending.then(() => {
        settled = true;
      });
      for (let attempt = 0; attempt < 10 && parserSpy.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(parserSpy).toHaveBeenCalledWith("python");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      releaseParser(null);
      await pending;
      expect(settled).toBe(true);
    } finally {
      releaseParser(null);
      parserSpy.mockRestore();
    }
  });
});
