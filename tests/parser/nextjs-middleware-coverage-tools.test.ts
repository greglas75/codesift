import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  nextjsMiddlewareCoverage,
  flagSecurityWarnings,
} from "../../src/tools/nextjs-middleware-coverage-tools.js";

describe("nextjs-middleware-coverage-tools exports", () => {
  it("exports nextjsMiddlewareCoverage function", () => {
    expect(typeof nextjsMiddlewareCoverage).toBe("function");
  });
});

describe("flagSecurityWarnings", () => {
  it("flags unprotected /admin/dashboard as high severity", () => {
    const warnings = flagSecurityWarnings({
      protected: [],
      unprotected: ["/admin/dashboard"],
      total_routes: 1,
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("high");
    expect(warnings[0]!.route).toBe("/admin/dashboard");
  });

  it("does not flag protected /admin/users", () => {
    const warnings = flagSecurityWarnings({
      protected: ["/admin/users"],
      unprotected: [],
      total_routes: 1,
    });
    expect(warnings.length).toBe(0);
  });

  it("respects custom flag_admin_prefix override", () => {
    const warnings = flagSecurityWarnings(
      {
        protected: [],
        unprotected: ["/dashboard/settings"],
        total_routes: 1,
      },
      { flag_admin_prefix: "/dashboard" },
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("high");
  });
});

describe("nextjsMiddlewareCoverage orchestrator", () => {
  let tmpRoot: string;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-mw-cov-"));
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

  it("classifies routes with admin matcher correctly", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "middleware.ts": `export const config = { matcher: ["/admin/:path*"] };\nexport default function middleware() {}\n`,
      "app/admin/dashboard/page.tsx": `export default function D() { return <div/>; }\n`,
      "app/admin/users/page.tsx": `export default function U() { return <div/>; }\n`,
      "app/page.tsx": `export default function H() { return <div/>; }\n`,
      "app/about/page.tsx": `export default function A() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsMiddlewareCoverage("test");
      expect(result.coverage.protected).toEqual(
        expect.arrayContaining(["/admin/dashboard", "/admin/users"]),
      );
      expect(result.coverage.unprotected).toEqual(
        expect.arrayContaining(["/", "/about"]),
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("matches pre-authored expected.json (fixture)", async () => {
    const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-middleware-coverage");
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-middleware-coverage",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
    const expectedRaw = await readFile(resolve(fixtureRoot, "expected.json"), "utf8");
    const expected = JSON.parse(expectedRaw) as {
      protected: string[];
      unprotected: string[];
      warnings: unknown[];
    };
    const result = await nextjsMiddlewareCoverage("nextjs-middleware-coverage");
    expect(result.coverage.protected.sort()).toEqual(expected.protected.sort());
    expect(result.coverage.unprotected.sort()).toEqual(expected.unprotected.sort());
    expect(result.warnings.length).toBe(expected.warnings.length);
  });

  it("flags admin routes with high-severity warnings when no middleware", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/admin/page.tsx": `export default function A() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsMiddlewareCoverage("test");
      const adminWarning = result.warnings.find((w) => w.route === "/admin");
      expect(adminWarning).toBeDefined();
      expect(adminWarning!.severity).toBe("high");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
