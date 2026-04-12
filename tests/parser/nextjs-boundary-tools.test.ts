import { describe, it, expect, vi } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  nextjsBoundaryAnalyzer,
  extractComponentSignals,
  rankingScore,
} from "../../src/tools/nextjs-boundary-tools.js";

async function parseTs(source: string) {
  const tree = await parseFile("x.tsx", source);
  if (!tree) throw new Error("parse failed");
  return tree;
}

describe("nextjs-boundary-tools exports", () => {
  it("exports nextjsBoundaryAnalyzer function", () => {
    expect(typeof nextjsBoundaryAnalyzer).toBe("function");
  });
});

describe("extractComponentSignals", () => {
  it("counts LOC, imports, and dynamic imports", async () => {
    const src = `import { useState } from "react";
import { Foo } from "./local";
import dynamic from "next/dynamic";
const Lazy = dynamic(() => import("./Lazy"));
export default function Comp() { return <div/>; }
`;
    const tree = await parseTs(src);
    const signals = extractComponentSignals("comp.tsx", src, tree);
    expect(signals.loc).toBeGreaterThan(0);
    expect(signals.import_count).toBe(3);
    expect(signals.dynamic_import_count).toBe(1);
    expect(signals.third_party_imports).toContain("react");
    expect(signals.third_party_imports).toContain("next/dynamic");
  });

  it("classifies local vs third-party imports correctly", async () => {
    const src = `import { x } from "./local";
import { y } from "react";
import { z } from "@/components";
`;
    const tree = await parseTs(src);
    const signals = extractComponentSignals("comp.tsx", src, tree);
    expect(signals.third_party_imports).toEqual(["react"]);
  });

  it("counts dynamic imports separately", async () => {
    const src = `import dynamic from "next/dynamic";
const A = dynamic(() => import("./A"));
const B = dynamic(() => import("./B"));
`;
    const tree = await parseTs(src);
    const signals = extractComponentSignals("comp.tsx", src, tree);
    expect(signals.dynamic_import_count).toBe(2);
  });

  it("returns zero counts for empty file", async () => {
    const src = ``;
    const tree = await parseTs(src);
    const signals = extractComponentSignals("empty.tsx", src, tree);
    expect(signals.import_count).toBe(0);
    expect(signals.dynamic_import_count).toBe(0);
    expect(signals.third_party_imports).toEqual([]);
  });
});

describe("rankingScore", () => {
  it("computes formula loc + imports*20 + dynamic*-30 + thirdparty*15", () => {
    const score = rankingScore({
      loc: 100,
      import_count: 5,
      dynamic_import_count: 0,
      third_party_imports: ["react", "lodash"],
    });
    expect(score).toBe(100 + 5 * 20 + 0 + 2 * 15);
  });

  it("subtracts points for dynamic imports", () => {
    const score = rankingScore({
      loc: 100,
      import_count: 0,
      dynamic_import_count: 1,
      third_party_imports: [],
    });
    expect(score).toBe(70);
  });

  it("returns loc for file with only local imports", () => {
    const score = rankingScore({
      loc: 50,
      import_count: 3,
      dynamic_import_count: 0,
      third_party_imports: [],
    });
    expect(score).toBe(50 + 60);
  });

  it("returns 0 for empty signals", () => {
    expect(
      rankingScore({
        loc: 0,
        import_count: 0,
        dynamic_import_count: 0,
        third_party_imports: [],
      }),
    ).toBe(0);
  });
});

describe("nextjsBoundaryAnalyzer orchestrator", () => {
  let tmpRoot: string;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-boundary-"));
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

  it("returns BoundaryEntry array for files with use client", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/big.tsx": `"use client";\nimport { useState } from "react";\nimport _ from "lodash";\nexport default function Big() { return <div/>; }\n`,
      "app/server.tsx": `export default function Server() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsBoundaryAnalyzer("test");
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      expect(result.entries[0]!.path).toContain("big.tsx");
      expect(result.client_count).toBe(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("sorts by score descending", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/small.tsx": `"use client";\nexport default function S() { return <div/>; }\n`,
      "app/big.tsx": `"use client";\nimport { useState } from "react";\nimport _ from "lodash";\nimport q from "query-string";\nexport default function B() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsBoundaryAnalyzer("test");
      expect(result.entries.length).toBe(2);
      expect(result.entries[0]!.score).toBeGreaterThanOrEqual(result.entries[1]!.score);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("populates client_count and total_client_loc aggregates", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/a.tsx": `"use client";\nexport default function A() { return null; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsBoundaryAnalyzer("test");
      expect(result.client_count).toBeGreaterThanOrEqual(1);
      expect(result.total_client_loc).toBeGreaterThan(0);
      expect(result.largest_offender).toBeDefined();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
