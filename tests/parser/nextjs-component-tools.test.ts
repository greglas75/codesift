import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Mock getCodeIndex so the orchestrator tests can point at filesystem fixtures
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
import { getCodeIndex } from "../../src/tools/index-tools.js";

import {
  analyzeNextjsComponents,
  classifyFile,
  detectSignals,
  applyClassificationTable,
} from "../../src/tools/nextjs-component-tools.js";
import type { ComponentSignals } from "../../src/tools/nextjs-component-tools.js";
import { parseFile } from "../../src/parser/parser-manager.js";

const emptySignals = (): ComponentSignals => ({
  hooks: [],
  event_handlers: [],
  browser_globals: [],
  dynamic_ssr_false: false,
});

describe("nextjs-component-tools exports", () => {
  it("exports analyzeNextjsComponents function", () => {
    expect(typeof analyzeNextjsComponents).toBe("function");
  });
});

describe("classifyFile directive detection", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-classify-"));
    await mkdir(join(tmpRoot, "app"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeFile(rel: string, content: string): Promise<string> {
    const abs = join(tmpRoot, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
    return abs;
  }

  it("detects top-level 'use client' directive", async () => {
    const file = await makeFile(
      "app/TopLevel.tsx",
      `"use client";\n\nexport function Foo() { return <div/>; }\n`,
    );
    const entry = await classifyFile(file, tmpRoot);
    expect(entry.directive).toBe("use client");
  });

  it("rejects conditional directive (not in Program.body[0])", async () => {
    const file = await makeFile(
      "app/Conditional.tsx",
      `function wrap() {\n  if (true) { "use client"; }\n}\nexport function Foo() { return <div/>; }\n`,
    );
    const entry = await classifyFile(file, tmpRoot);
    expect(entry.directive).toBeNull();
  });

  it("returns ambiguous on malformed file that fails tree-sitter parse", async () => {
    // Give it a .nonexistent extension that parser-manager can't handle
    const file = await makeFile(
      "app/NotAFile.unknownext",
      `"use client";\nmalformed content`,
    );
    const entry = await classifyFile(file, tmpRoot);
    expect(entry.classification).toBe("ambiguous");
  });

  it("rejects directive found only inside a comment (stage 3 AST check)", async () => {
    const file = await makeFile(
      "app/InComment.tsx",
      `// not a directive: "use client"\nexport function Foo() { return <div/>; }\n`,
    );
    const entry = await classifyFile(file, tmpRoot);
    // scanDirective strips comments, so stage 1 already rejects. AST never sees it.
    expect(entry.directive).toBeNull();
  });
});

describe("detectSignals", () => {
  async function parse(source: string) {
    const fakePath = "/tmp/virtual.tsx";
    const tree = await parseFile(fakePath, source);
    if (!tree) throw new Error("parse failed");
    return { tree, source };
  }

  it("detects React hook calls", async () => {
    const { tree, source } = await parse(
      `import { useState } from "react";\nfunction Foo() { const [a, b] = useState(0); return null; }\n`,
    );
    const signals = detectSignals(tree, source);
    expect(signals.hooks).toContain("useState");
  });

  it("detects JSX event handlers", async () => {
    const { tree, source } = await parse(
      `function Btn() { return <button onClick={() => {}}>x</button>; }\n`,
    );
    const signals = detectSignals(tree, source);
    expect(signals.event_handlers).toContain("onClick");
  });

  it("detects browser globals via member expression", async () => {
    const { tree, source } = await parse(
      `function foo() { return window.location.href; }\n`,
    );
    const signals = detectSignals(tree, source);
    expect(signals.browser_globals).toContain("window");
  });

  it("detects next/dynamic with ssr:false", async () => {
    const { tree, source } = await parse(
      `import dynamic from "next/dynamic";\nconst X = dynamic(() => import("./x"), { ssr: false });\n`,
    );
    const signals = detectSignals(tree, source);
    expect(signals.dynamic_ssr_false).toBe(true);
  });

  it("returns all-empty for a file with no client signals", async () => {
    const { tree, source } = await parse(
      `export function Server({ data }: { data: string }) { return <div>{data}</div>; }\n`,
    );
    const signals = detectSignals(tree, source);
    expect(signals.hooks).toEqual([]);
    expect(signals.event_handlers).toEqual([]);
    expect(signals.browser_globals).toEqual([]);
    expect(signals.dynamic_ssr_false).toBe(false);
  });
});

describe("applyClassificationTable", () => {
  it("row 1: no directive + no signals -> server", () => {
    expect(applyClassificationTable(null, emptySignals())).toEqual({
      classification: "server",
      violations: [],
    });
  });

  it("row 2: no directive + hooks -> client_inferred", () => {
    expect(
      applyClassificationTable(null, { ...emptySignals(), hooks: ["useState"] }),
    ).toEqual({ classification: "client_inferred", violations: [] });
  });

  it("row 3: no directive + events -> client_inferred", () => {
    expect(
      applyClassificationTable(null, {
        ...emptySignals(),
        event_handlers: ["onClick"],
      }),
    ).toEqual({ classification: "client_inferred", violations: [] });
  });

  it("row 4: no directive + browser globals -> client_inferred", () => {
    expect(
      applyClassificationTable(null, {
        ...emptySignals(),
        browser_globals: ["window"],
      }),
    ).toEqual({ classification: "client_inferred", violations: [] });
  });

  it("row 5: use client + no signals -> client_explicit + unnecessary_use_client", () => {
    expect(applyClassificationTable("use client", emptySignals())).toEqual({
      classification: "client_explicit",
      violations: ["unnecessary_use_client"],
    });
  });

  it("row 6: use client + hooks -> client_explicit, no violation", () => {
    expect(
      applyClassificationTable("use client", {
        ...emptySignals(),
        hooks: ["useState"],
      }),
    ).toEqual({ classification: "client_explicit", violations: [] });
  });

  it("row 7: use server + no signals -> server", () => {
    expect(applyClassificationTable("use server", emptySignals())).toEqual({
      classification: "server",
      violations: [],
    });
  });

  it("row 8: no directive + dynamic_ssr_false -> client_inferred", () => {
    expect(
      applyClassificationTable(null, {
        ...emptySignals(),
        dynamic_ssr_false: true,
      }),
    ).toEqual({ classification: "client_inferred", violations: [] });
  });
});

describe("analyzeNextjsComponents — App Router fixture", () => {
  const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-app-router");

  beforeAll(() => {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-app-router",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
  });

  it("scans at least 20 component files", async () => {
    const result = await analyzeNextjsComponents("nextjs-app-router");
    expect(result.counts.total).toBeGreaterThanOrEqual(20);
  });

  it("parse_failures is empty (fixture invariant)", async () => {
    const result = await analyzeNextjsComponents("nextjs-app-router");
    expect(result.parse_failures).toEqual([]);
  });

  it("detects at least one unnecessary_use_client violation", async () => {
    const result = await analyzeNextjsComponents("nextjs-app-router");
    expect(result.counts.unnecessary_use_client).toBeGreaterThanOrEqual(1);
  });

  it("detects at least three client_explicit components", async () => {
    const result = await analyzeNextjsComponents("nextjs-app-router");
    expect(result.counts.client_explicit).toBeGreaterThanOrEqual(3);
  });
});


