import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getCodeIndex for orchestrator integration tests (Task 30)
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
import { getCodeIndex } from "../../src/tools/index-tools.js";

import {
  nextjsRouteMap,
  readRouteSegmentConfig,
  classifyRendering,
  parseRouteFile,
} from "../../src/tools/nextjs-route-tools.js";
import type { RouteSegmentConfig } from "../../src/tools/nextjs-route-tools.js";
import { parseFile } from "../../src/parser/parser-manager.js";

const baseConfig = (): RouteSegmentConfig => ({ has_generate_static_params: false });

describe("nextjs-route-tools exports", () => {
  it("exports nextjsRouteMap function", () => {
    expect(typeof nextjsRouteMap).toBe("function");
  });
});

async function parseSource(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "nextjs-route-"));
  const p = join(dir, "x.tsx");
  await writeFile(p, source);
  const tree = await parseFile(p, source);
  if (!tree) throw new Error("parse failed");
  return { tree, source };
}

describe("readRouteSegmentConfig", () => {
  it("reads dynamic = 'force-dynamic'", async () => {
    const { tree, source } = await parseSource(
      `export const dynamic = "force-dynamic";\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.dynamic).toBe("force-dynamic");
  });

  it("reads revalidate = 60", async () => {
    const { tree, source } = await parseSource(`export const revalidate = 60;\n`);
    const config = readRouteSegmentConfig(tree, source);
    expect(config.revalidate).toBe(60);
  });

  it("reads revalidate = false", async () => {
    const { tree, source } = await parseSource(
      `export const revalidate = false;\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.revalidate).toBe(false);
  });

  it("reads runtime = 'edge'", async () => {
    const { tree, source } = await parseSource(`export const runtime = "edge";\n`);
    const config = readRouteSegmentConfig(tree, source);
    expect(config.runtime).toBe("edge");
  });

  it("marks dynamic = <identifier> as dynamic_non_literal", async () => {
    const { tree, source } = await parseSource(
      `export const dynamic = someVar;\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.dynamic).toBeUndefined();
    expect(config.dynamic_non_literal).toBe(true);
  });

  it("detects generateStaticParams", async () => {
    const { tree, source } = await parseSource(
      `export async function generateStaticParams() { return []; }\n`,
    );
    const config = readRouteSegmentConfig(tree, source);
    expect(config.has_generate_static_params).toBe(true);
  });
});

describe("classifyRendering", () => {
  it("row 1: App Router, force-dynamic -> ssr", () => {
    expect(
      classifyRendering({ ...baseConfig(), dynamic: "force-dynamic" }, "app"),
    ).toBe("ssr");
  });

  it("row 2: App Router, force-static -> static", () => {
    expect(
      classifyRendering({ ...baseConfig(), dynamic: "force-static" }, "app"),
    ).toBe("static");
  });

  it("row 3: App Router, revalidate = 60 -> isr", () => {
    expect(classifyRendering({ ...baseConfig(), revalidate: 60 }, "app")).toBe(
      "isr",
    );
  });

  it("row 4: App Router, runtime = edge -> edge", () => {
    expect(classifyRendering({ ...baseConfig(), runtime: "edge" }, "app")).toBe(
      "edge",
    );
  });

  it("row 5: App Router, has_generate_static_params -> static", () => {
    expect(
      classifyRendering({ ...baseConfig(), has_generate_static_params: true }, "app"),
    ).toBe("static");
  });

  it("row 6: App Router, no config -> static (Next.js default)", () => {
    expect(classifyRendering(baseConfig(), "app")).toBe("static");
  });

  it("row 7: Pages Router, hasGetServerSideProps -> ssr", () => {
    expect(
      classifyRendering(baseConfig(), "pages", { hasGetServerSideProps: true }),
    ).toBe("ssr");
  });

  it("row 8: Pages Router, hasGetStaticProps without revalidate -> static", () => {
    expect(
      classifyRendering(baseConfig(), "pages", {
        hasGetStaticProps: true,
        hasRevalidateInReturn: false,
      }),
    ).toBe("static");
  });
});

describe("parseRouteFile", () => {
  async function write(tmpRoot: string, rel: string, content: string): Promise<string> {
    const abs = join(tmpRoot, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
    return abs;
  }

  it("classifies app/page.tsx as static with no metadata", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "parse-route-"));
    try {
      const abs = await write(tmpRoot,
        "app/page.tsx",
        `export default function Home() { return <div/>; }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.rendering).toBe("static");
      expect(entry.has_metadata).toBe(false);
      expect(entry.url_path).toBe("/");
      expect(entry.type).toBe("page");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("detects metadata export and dynamic segment", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "parse-route-"));
    try {
      const abs = await write(tmpRoot,
        "app/products/[id]/page.tsx",
        `export const metadata = { title: "Product" };\nexport default function P() { return <div/>; }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.has_metadata).toBe(true);
      expect(entry.url_path).toBe("/products/[id]");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("extracts HTTP methods from route.ts", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "parse-route-"));
    try {
      const abs = await write(tmpRoot,
        "app/api/users/route.ts",
        `export async function GET() { return new Response(); }\nexport async function POST() { return new Response(); }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.type).toBe("route");
      expect(entry.methods).toEqual(expect.arrayContaining(["GET", "POST"]));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("derives Pages Router URL path", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "parse-route-"));
    try {
      const abs = await write(tmpRoot,
        "pages/api/users.ts",
        `export default function handler(req: unknown, res: any) { res.json({}); }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "pages");
      expect(entry.router).toBe("pages");
      expect(entry.url_path).toBe("/api/users");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("strips route group from url_path", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "parse-route-"));
    try {
      const abs = await write(tmpRoot,
        "app/(auth)/login/page.tsx",
        `export default function Login() { return <div/>; }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.url_path).toBe("/login");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("nextjsRouteMap orchestrator", () => {
  async function makeRepo(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "route-map-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    return root;
  }

  function mockIndex(root: string): void {
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);
  }

  it("enumerates App Router routes with no conflicts", async () => {
    const root = await makeRepo({
      "app/layout.tsx": `export default function L({ children }: any) { return children; }\n`,
      "app/page.tsx": `export default function P() { return <div/>; }\n`,
      "app/(auth)/login/page.tsx": `export default function Login() { return <div/>; }\n`,
      "app/api/users/route.ts": `export async function GET() { return new Response(); }\n`,
      "middleware.ts": `export const config = { matcher: "/api/:path*" };\nexport function middleware() {}\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsRouteMap("test");
      expect(result.routes.length).toBeGreaterThanOrEqual(4);
      expect(result.conflicts).toEqual([]);
      expect(result.scan_errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("enumerates Pages Router routes with correct type values", async () => {
    const root = await makeRepo({
      "pages/_app.tsx": `export default function A({ Component, pageProps }: any) { return <Component {...pageProps}/>; }\n`,
      "pages/_document.tsx": `export default function D() { return <div/>; }\n`,
      "pages/_error.tsx": `export default function E() { return <div/>; }\n`,
      "pages/index.tsx": `export default function H() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsRouteMap("test");
      const types = new Set(result.routes.map((r) => r.type));
      expect(types.has("app")).toBe(true);
      expect(types.has("document")).toBe(true);
      expect(types.has("error_page")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rendering_reason reports cookies() call as SSR trigger", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "rendering-reason-"));
    try {
      const rel = "app/profile/page.tsx";
      const abs = join(tmpRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        `import { cookies } from 'next/headers';\nexport default async function Page() {\n  const jar = cookies();\n  return <div>{jar.get('session')?.value}</div>;\n}\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.rendering).toBe("ssr");
      expect(entry.rendering_reason).toBeDefined();
      expect(entry.rendering_reason!).toMatch(/cookies\(\)/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rendering_reason reports fetch no-store as SSR trigger", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "rendering-reason-"));
    try {
      const rel = "app/feed/page.tsx";
      const abs = join(tmpRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        `export default async function Page() {\n  const res = await fetch('/api/feed', { cache: 'no-store' });\n  return <div>{await res.text()}</div>;\n}\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.rendering).toBe("ssr");
      expect(entry.rendering_reason).toBeDefined();
      expect(entry.rendering_reason!).toMatch(/no-store/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rendering_reason reports dynamic=force-dynamic config export", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "rendering-reason-"));
    try {
      const rel = "app/dashboard/page.tsx";
      const abs = join(tmpRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        `export const dynamic = "force-dynamic";\nexport default function Page() { return <div>hi</div>; }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.rendering).toBe("ssr");
      expect(entry.rendering_reason).toBeDefined();
      expect(entry.rendering_reason!).toMatch(/force-dynamic/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rendering_reason is undefined for static pages", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "rendering-reason-"));
    try {
      const rel = "app/about/page.tsx";
      const abs = join(tmpRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        `export default function Page() { return <div>static</div>; }\n`,
      );
      const entry = await parseRouteFile(abs, tmpRoot, "app");
      expect(entry.rendering).toBe("static");
      expect(entry.rendering_reason).toBeUndefined();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("detects hybrid conflict when same URL exists in both routers", async () => {
    // Monorepo: two workspaces under apps/
    const root = await makeRepo({
      "apps/web-app/next.config.ts": `export default {};\n`,
      "apps/web-app/app/page.tsx": `export default function P() { return <div/>; }\n`,
      "apps/web-pages/next.config.js": `module.exports = {};\n`,
      "apps/web-pages/pages/index.tsx": `export default function H() { return <div/>; }\n`,
    });
    try {
      mockIndex(root);
      const result = await nextjsRouteMap("test");
      // Each workspace scanned for its own router; hybrid conflict requires
      // the same URL appearing in both routers within a single workspace OR
      // across workspaces. We emit conflicts by grouping on url_path.
      const rootRoutes = result.routes.filter((r) => r.url_path === "/");
      expect(rootRoutes.length).toBe(2);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(result.conflicts[0]!.url_path).toBe("/");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
