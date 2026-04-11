import { describe, it, expect, afterEach } from "vitest";
import { traceRoute, matchPath } from "../../src/tools/route-tools.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CodeIndex without hitting disk or a real repo. */
function makeIndex(
  files: Array<{ path: string; language?: string }>,
  symbols: Partial<CodeSymbol>[] = [],
): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    files: files.map((f) => ({
      path: f.path,
      language: f.language ?? "typescript",
      symbol_count: 0,
      last_modified: Date.now(),
    })) as FileEntry[],
    symbols: symbols.map((s, i) => ({
      id: s.id ?? `test:${s.file}:${s.name}:${s.start_line ?? i}`,
      repo: "test",
      name: s.name ?? "unknown",
      kind: s.kind ?? "function",
      file: s.file ?? "",
      start_line: s.start_line ?? 1,
      end_line: s.end_line ?? 1,
      ...s,
    })) as CodeSymbol[],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

// Patch getCodeIndex so traceRoute uses our fixture index without a real repo.
import * as indexTools from "../../src/tools/index-tools.js";
import { vi } from "vitest";

function withIndex(index: CodeIndex, fn: () => Promise<void>): Promise<void> {
  const spy = vi.spyOn(indexTools, "getCodeIndex").mockResolvedValue(index);
  return fn().finally(() => spy.mockRestore());
}

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-route-test-"));
  const projDir = join(tmpDir, "test-project");
  await mkdir(projDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(projDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await indexFolder(projDir, { watch: false });
  return "local/test-project";
}

// ---------------------------------------------------------------------------
// matchPath (pure, no I/O)
// ---------------------------------------------------------------------------

describe("matchPath", () => {
  it("matches static paths", () => {
    expect(matchPath("/blog/hello", "/blog/hello")).toBe(true);
  });

  it("matches dynamic :param segment", () => {
    expect(matchPath("/blog/:slug", "/blog/hello")).toBe(true);
  });

  it("matches Next.js [param] segment", () => {
    expect(matchPath("/blog/[slug]", "/blog/hello")).toBe(true);
  });

  it("does not match different segment counts", () => {
    expect(matchPath("/a/b", "/a")).toBe(false);
  });

  it("does not match different static segments", () => {
    expect(matchPath("/blog/hello", "/blog/world")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// traceRoute — Astro dispatch (Task 15)
// ---------------------------------------------------------------------------

describe("traceRoute — Astro", () => {
  it("resolves /blog/hello to handler with framework astro", async () => {
    const index = makeIndex(
      [{ path: "src/pages/blog/[slug].astro", language: "astro" }],
      [
        {
          name: "getStaticPaths",
          file: "src/pages/blog/[slug].astro",
          kind: "function",
          start_line: 2,
          end_line: 5,
        },
        {
          name: "default",
          file: "src/pages/blog/[slug].astro",
          kind: "function",
          start_line: 7,
          end_line: 20,
        },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/blog/hello");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers.length).toBeGreaterThan(0);
      expect(result.handlers[0]!.framework).toBe("astro");
      expect(result.handlers[0]!.file).toBe("src/pages/blog/[slug].astro");
    });
  });

  it("resolves /api/data to endpoint handler with framework astro", async () => {
    const index = makeIndex(
      [{ path: "src/pages/api/data.ts", language: "typescript" }],
      [
        {
          name: "GET",
          file: "src/pages/api/data.ts",
          kind: "function",
          start_line: 1,
          end_line: 5,
        },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/api/data");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers.length).toBeGreaterThan(0);
      const handler = result.handlers[0]!;
      expect(handler.framework).toBe("astro");
      expect(handler.file).toBe("src/pages/api/data.ts");
      expect(handler.method).toBe("GET");
    });
  });
});

// ---------------------------------------------------------------------------
// Next.js handler tests (indexed fixture)
// ---------------------------------------------------------------------------

describe("findNextJSHandlers tsx support", () => {
  it("finds handler in route.tsx file", async () => {
    const repo = await createIndexedFixture({
      "app/api/upload/route.tsx": `import { NextResponse } from "next/server";
export async function POST(request: Request) {
  return NextResponse.json({ ok: true });
}`,
    });
    const result = await traceRoute(repo, "/api/upload");
    expect(result.handlers.length).toBeGreaterThanOrEqual(1);
    expect(result.handlers[0]!.symbol.name).toBe("POST");
  });

  it("still finds handler in route.ts file (regression)", async () => {
    const repo = await createIndexedFixture({
      "app/api/users/route.ts": `import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ users: [] });
}`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.handlers.length).toBeGreaterThanOrEqual(1);
    expect(result.handlers[0]!.symbol.name).toBe("GET");
  });
});

describe("PagesRouter handler detection", () => {
  it("finds default export handler in pages/api/", async () => {
    const repo = await createIndexedFixture({
      "next.config.js": `module.exports = {};`,
      "pages/api/users.ts": `export default function handler(req, res) {
  res.status(200).json({ users: [] });
}`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.handlers.length).toBeGreaterThanOrEqual(1);
    expect(result.handlers[0]!.router).toBe("pages");
  });

  it("returns both handlers in hybrid App + Pages Router", async () => {
    const repo = await createIndexedFixture({
      "pages/api/users.ts": `export default function handler(req, res) {
  res.status(200).json({ users: [] });
}`,
      "app/api/users/route.ts": `import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ users: [] });
}`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.handlers.length).toBeGreaterThanOrEqual(2);
    const routers = result.handlers.map((h) => h.router);
    expect(routers).toContain("pages");
    expect(routers).toContain("app");
  });

  it("resolves variable-indirection default export", async () => {
    const repo = await createIndexedFixture({
      "next.config.js": `module.exports = {};`,
      "pages/api/exotic.ts": `const h = (req, res) => {
  res.status(200).json({ ok: true });
};
export default h;`,
    });
    const result = await traceRoute(repo, "/api/exotic");
    expect(result.handlers.length).toBeGreaterThanOrEqual(1);
  });
});

describe("layout_chain in traceRoute", () => {
  it("returns layout chain for route with ancestor layouts", async () => {
    const repo = await createIndexedFixture({
      "app/layout.tsx": `export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }`,
      "app/products/layout.tsx": `export default function ProductsLayout({ children }) { return <div>{children}</div>; }`,
      "app/products/[id]/page.tsx": `export default function ProductPage({ params }) { return <div>Product {params.id}</div>; }`,
      "app/products/[id]/route.ts": `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({}); }`,
    });
    const result = await traceRoute(repo, "/products/123");
    expect(result.layout_chain).toEqual(["app/layout.tsx", "app/products/layout.tsx"]);
  });

  it("returns empty layout chain when no layouts exist", async () => {
    const repo = await createIndexedFixture({
      "app/api/test/route.ts": `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({}); }`,
    });
    const result = await traceRoute(repo, "/api/test");
    expect(result.layout_chain).toEqual([]);
  });
});

describe("middleware in traceRoute", () => {
  it("returns middleware.applies=true when matcher covers path", async () => {
    const repo = await createIndexedFixture({
      "middleware.ts": `import { NextResponse } from "next/server";
export const config = { matcher: ["/api/:path*"] };
export function middleware(req) { return NextResponse.next(); }`,
      "app/api/users/route.ts": `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({}); }`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.middleware).toBeDefined();
    expect(result.middleware!.applies).toBe(true);
    expect(result.middleware!.matchers).toEqual(["/api/:path*"]);
  });

  it("returns middleware.applies=false when matcher does not cover path", async () => {
    const repo = await createIndexedFixture({
      "middleware.ts": `import { NextResponse } from "next/server";
export const config = { matcher: ["/admin/:path*"] };
export function middleware(req) { return NextResponse.next(); }`,
      "app/api/users/route.ts": `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({}); }`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.middleware).toBeDefined();
    expect(result.middleware!.applies).toBe(false);
  });
});

describe("server_actions in traceRoute", () => {
  it("detects server actions called from route handler", async () => {
    const repo = await createIndexedFixture({
      "app/actions/updateUser.ts": `"use server";
export async function updateUser(data: any) {
  return { ok: true };
}`,
      "app/users/page.tsx": `import { updateUser } from "../actions/updateUser";
export default function UsersPage() {
  return <form action={updateUser}><button>Save</button></form>;
}`,
      "app/users/route.ts": `import { NextResponse } from "next/server";
import { updateUser } from "../actions/updateUser";
export async function POST() {
  await updateUser({});
  return NextResponse.json({});
}`,
    });
    const result = await traceRoute(repo, "/users");
    expect(result.server_actions).toBeDefined();
    expect(result.server_actions!.length).toBeGreaterThanOrEqual(1);
    expect(result.server_actions!.some((a) => a.name === "updateUser")).toBe(true);
  });

  it("returns empty server_actions when no use server files", async () => {
    const repo = await createIndexedFixture({
      "app/api/test/route.ts": `import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({}); }`,
    });
    const result = await traceRoute(repo, "/api/test");
    expect(result.server_actions).toEqual([]);
  });

  it("traces Hono route to handler with framework=hono (AC-R1)", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
export default app;`,
    });
    const result = await traceRoute(repo, "/health");
    expect(result.handlers.length).toBeGreaterThan(0);
    const honoHandler = result.handlers.find((h) => h.framework === "hono");
    expect(honoHandler).toBeDefined();
    expect(honoHandler?.method).toBe("GET");
  });

  it("traces Hono parameterized path (AC-R1 with param)", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
export default app;`,
    });
    const result = await traceRoute(repo, "/users/:id");
    const honoHandler = result.handlers.find((h) => h.framework === "hono");
    expect(honoHandler).toBeDefined();
  });

  it("does not detect function-body use server (file-level only)", async () => {
    const repo = await createIndexedFixture({
      "app/lib/actions.ts": `export async function save() {
  "use server";
  return { ok: true };
}`,
      "app/api/test/route.ts": `import { NextResponse } from "next/server";
import { save } from "../../lib/actions";
export async function POST() {
  await save();
  return NextResponse.json({});
}`,
    });
    const result = await traceRoute(repo, "/api/test");
    // Function-body "use server" should NOT be detected
    expect(result.server_actions).toEqual([]);
  });
});
