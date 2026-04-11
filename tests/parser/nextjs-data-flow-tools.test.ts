import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  nextjsDataFlow,
  classifyFetches,
  classifyCacheStrategy,
} from "../../src/tools/nextjs-data-flow-tools.js";
import type { FetchCall } from "../../src/utils/nextjs.js";

const mkFetch = (overrides: Partial<FetchCall>): FetchCall => ({
  callee: "fetch",
  line: 1,
  cacheOption: null,
  isSequential: false,
  isSsrTrigger: false,
  ...overrides,
});

describe("nextjs-data-flow-tools exports", () => {
  it("exports nextjsDataFlow function", () => {
    expect(typeof nextjsDataFlow).toBe("function");
  });
});

describe("classifyFetches", () => {
  it("flags two sequential awaits as a waterfall pair", () => {
    const result = classifyFetches([
      mkFetch({ line: 1 }),
      mkFetch({ line: 2, isSequential: true }),
    ]);
    expect(result.waterfall_pairs.length).toBe(1);
  });

  it("does not flag single fetch as waterfall", () => {
    const result = classifyFetches([mkFetch({ line: 1 })]);
    expect(result.waterfall_pairs.length).toBe(0);
  });

  it("does not flag dependent awaits (isSequential=false)", () => {
    const result = classifyFetches([
      mkFetch({ line: 1 }),
      mkFetch({ line: 2, isSequential: false }),
    ]);
    expect(result.waterfall_pairs.length).toBe(0);
  });
});

describe("classifyCacheStrategy", () => {
  it("returns no-cache for cache: 'no-store'", () => {
    expect(classifyCacheStrategy(mkFetch({ cacheOption: "no-store" }))).toBe("no-cache");
  });

  it("returns cached for cache: 'force-cache'", () => {
    expect(classifyCacheStrategy(mkFetch({ cacheOption: "force-cache" }))).toBe("cached");
  });

  it("returns isr-N for next.revalidate", () => {
    expect(classifyCacheStrategy(mkFetch({ cacheOption: "isr-60" }))).toBe("isr-60");
  });

  it("returns default for no options", () => {
    expect(classifyCacheStrategy(mkFetch({ cacheOption: null }))).toBe("default");
  });
});

describe("nextjsDataFlow orchestrator", () => {
  let tmpRoot: string;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-data-flow-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(tmpRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    return tmpRoot;
  }

  function mockIndex(root: string) {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
  }

  it("detects sequential awaits as waterfall_count: 1", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `export default async function Page() {
  const a = await fetch("/api/a");
  const b = await fetch("/api/b");
  return <div/>;
}
`,
    });
    try {
      mockIndex(root);
      const result = await nextjsDataFlow("test");
      expect(result.total_waterfalls).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns waterfall_count: 0 for Promise.all parallel pattern", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `export default async function Page() {
  const [a, b] = await Promise.all([fetch("/api/a"), fetch("/api/b")]);
  return <div/>;
}
`,
    });
    try {
      mockIndex(root);
      const result = await nextjsDataFlow("test");
      // Promise.all wrapping doesn't trigger our sequential detector since both
      // fetches are arguments to the same Promise.all call (same statement).
      expect(result.total_waterfalls).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("matches pre-authored expected.json (fixture)", async () => {
    const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-data-flow");
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-data-flow",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
    const expectedRaw = await readFile(resolve(fixtureRoot, "expected.json"), "utf8");
    const expected = JSON.parse(expectedRaw) as {
      total_pages: number;
      total_waterfalls: number;
      waterfall_url_paths: string[];
    };
    const result = await nextjsDataFlow("nextjs-data-flow");
    expect(result.total_pages).toBe(expected.total_pages);
    expect(result.total_waterfalls).toBe(expected.total_waterfalls);
    for (const url_path of expected.waterfall_url_paths) {
      const entry = result.entries.find((e) => e.url_path === url_path);
      expect(entry).toBeDefined();
      expect(entry!.waterfall_count).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns empty result when no data fetching", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `export default function Page() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsDataFlow("test");
      expect(result.total_waterfalls).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
