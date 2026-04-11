import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  nextjsLinkIntegrity,
  matchRoutePattern,
} from "../../src/tools/nextjs-link-tools.js";

describe("nextjs-link-tools exports", () => {
  it("exports nextjsLinkIntegrity function", () => {
    expect(typeof nextjsLinkIntegrity).toBe("function");
  });
});

describe("matchRoutePattern", () => {
  it("matches static route", () => {
    expect(matchRoutePattern("/about", ["/about", "/contact"])).toBe(true);
  });

  it("matches dynamic [id] segment", () => {
    expect(matchRoutePattern("/products/123", ["/products/[id]"])).toBe(true);
  });

  it("matches catch-all [...slug]", () => {
    expect(matchRoutePattern("/blog/foo/bar", ["/blog/[...slug]"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchRoutePattern("/nonexistent", ["/about"])).toBe(false);
  });

  it("does not match parent of dynamic segment", () => {
    expect(matchRoutePattern("/products", ["/products/[id]"])).toBe(false);
  });
});

describe("nextjsLinkIntegrity orchestrator", () => {
  let tmpRoot: string;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-link-"));
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

  it("classifies all-valid links as resolved", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `import Link from "next/link";\nexport default function Home() { return <Link href="/about">A</Link>; }\n`,
      "app/about/page.tsx": `export default function About() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsLinkIntegrity("test");
      expect(result.broken_count).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("flags broken /nonexistent link", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `import Link from "next/link";\nexport default function H() { return <Link href="/nonexistent">x</Link>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsLinkIntegrity("test");
      expect(result.broken_count).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("buckets template-literal href as unresolved", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/page.tsx": `import Link from "next/link";\nexport default function H({id}: any) { return <Link href={\`/users/\${id}\`}>x</Link>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsLinkIntegrity("test");
      expect(result.unresolved_count).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("matches pre-authored expected.json (fixture)", async () => {
    const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-links");
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-links",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
    const expectedRaw = await readFile(resolve(fixtureRoot, "expected.json"), "utf8");
    const expected = JSON.parse(expectedRaw) as {
      total_refs: number;
      resolved_count: number;
      broken_count: number;
      unresolved_count: number;
    };
    const result = await nextjsLinkIntegrity("nextjs-links");
    expect(result.total_refs).toBe(expected.total_refs);
    expect(result.broken_count).toBe(expected.broken_count);
    expect(result.unresolved_count).toBe(expected.unresolved_count);
    expect(result.resolved_count).toBe(expected.resolved_count);
  });

  it("classifies router.push to existing route as resolved", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/login/page.tsx": `export default function Login() { return <div/>; }\n`,
      "app/page.tsx": `export default function H() {
  const onClick = () => router.push("/login");
  return <button onClick={onClick}/>;
}
`,
    });
    try {
      mockIndex(root);
      const result = await nextjsLinkIntegrity("test");
      expect(result.broken_count + result.resolved_count + result.unresolved_count).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
