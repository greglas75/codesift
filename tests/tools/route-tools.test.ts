import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findNestJSHandlers,
  matchPath,
  routeToMermaid,
  traceRoute,
} from "../../src/tools/route-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import * as indexTools from "../../src/tools/index-tools.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

let tmpRoot: string;

function mockIndex(root: string, files: string[]): CodeIndex {
  return {
    root,
    files: files.map((p) => ({ path: p, size: 100 })),
    symbols: [],
  } as unknown as CodeIndex;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "nest-route-"));
  await mkdir(join(tmpRoot, "src/users"), { recursive: true });
  await mkdir(join(tmpRoot, "src/auth"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("findNestJSHandlers — string-literal paths (regression)", () => {
  it("finds handler with @Controller('api') + @Get('users')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class UsersController {
  @Get('users')
  findAll() { return []; }
}`;
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/users.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/api/users");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.method).toBe("GET");
    expect(handlers[0]!.framework).toBe("nestjs");
  });
});

describe("findNestJSHandlers — empty decorators", () => {
  it("finds handler with @Get() (empty method decorator)", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() { return 'ok'; }
}`;
    await writeFile(join(tmpRoot, "src/users/health.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/health.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/health");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.method).toBe("GET");
  });

  it("finds handler with @Controller() (empty prefix) + @Get('users')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('users')
  findUsers() { return []; }
}`;
    await writeFile(join(tmpRoot, "src/users/app.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/app.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/users");
    expect(handlers).toHaveLength(1);
  });

  it("finds handler with @Controller() + @Get() (both empty)", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class RootController {
  @Get()
  root() { return 'hello'; }
}`;
    await writeFile(join(tmpRoot, "src/users/root.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/root.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/");
    expect(handlers).toHaveLength(1);
  });
});

describe("findNestJSHandlers — parameterized paths", () => {
  it("finds handler with @Get(':id')", async () => {
    const source = `
import { Controller, Get } from '@nestjs/common';

@Controller('api/users')
export class UsersController {
  @Get(':id')
  findOne() { return {}; }
}`;
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/users.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/api/users/123");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.method).toBe("GET");
  });

  it("finds a handler when another decorator appears before the method", async () => {
    const source = `
@Controller('api')
export class UsersController {
  @Get('users')
  @UseGuards(AuthGuard)
  findAll() { return []; }
}`;
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), source);
    const handlers = await findNestJSHandlers(
      mockIndex(tmpRoot, ["src/users/users.controller.ts"]),
      "/api/users",
    );
    expect(handlers).toContainEqual(expect.objectContaining({ method: "GET" }));
  });
});

describe("findNestJSHandlers — edge cases", () => {
  it("does not throw on @Get with no parentheses", async () => {
    const source = `
import { Controller } from '@nestjs/common';

@Controller('test')
export class TestController {
  @Get
  noParens() { return 'x'; }
}`;
    await writeFile(join(tmpRoot, "src/users/test.controller.ts"), source);
    const index = mockIndex(tmpRoot, ["src/users/test.controller.ts"]);

    const handlers = await findNestJSHandlers(index, "/test");
    expect(handlers).toEqual([]);
  });

  it("returns empty array when no controller files exist", async () => {
    const index = mockIndex(tmpRoot, []);
    const handlers = await findNestJSHandlers(index, "/api/users");
    expect(handlers).toEqual([]);
  });
});

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
// (indexTools and vi already imported at top of file)

function withIndex(index: CodeIndex, fn: () => Promise<void>): Promise<void> {
  const spy = vi.spyOn(indexTools, "getCodeIndex").mockResolvedValue(index);
  return fn().finally(() => spy.mockRestore());
}

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  it("matches required and optional catch-all tails", () => {
    expect(matchPath("/docs/[...slug]", "/docs/a/b")).toBe(true);
    expect(matchPath("/docs/[[...slug]]", "/docs")).toBe(true);
    expect(matchPath("/docs/[[...slug]]", "/docs/a/b")).toBe(true);
    expect(matchPath("/docs/[...slug]", "/docs")).toBe(false);
  });

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

describe("route-tools public facade", () => {
  it("keeps the historical runtime exports reachable", () => {
    expect(findNestJSHandlers).toBeTypeOf("function");
    expect(matchPath).toBeTypeOf("function");
    expect(routeToMermaid).toBeTypeOf("function");
    expect(traceRoute).toBeTypeOf("function");
  });

  it("renders an explicit empty-route Mermaid result", () => {
    expect(routeToMermaid({
      path: "/missing",
      handlers: [],
      call_chain: [],
      db_calls: [],
    })).toBe("sequenceDiagram\n    Note over Client: No handler found for /missing");
  });

  it("keeps user paths on one Mermaid line", () => {
    const mermaid = routeToMermaid({
      path: "/safe\n    participant Injected",
      handlers: [{
        symbol: { id: "handler", repo: "test", name: "GET", kind: "function", file: "route.ts", start_line: 1, end_line: 1 },
        file: "route.ts",
        method: "GET",
        framework: "express",
      }],
      call_chain: [],
      db_calls: [],
    });
    expect(mermaid).not.toContain("\n    participant Injected");
  });
});

describe("traceRoute — framework dispatch characterization", () => {
  it("finds Express handlers without scanning test files", async () => {
    const index = makeIndex(
      [
        { path: "src/server.ts" },
        { path: "src/server.test.ts" },
      ],
      [
        { name: "health", file: "src/server.ts", source: "app.get('/health', health); app.get('/ready', ready)" },
        { name: "fixture", file: "src/server.test.ts", source: "app.get('/health', fixture)" },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/health");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers).toHaveLength(1);
      expect(result.handlers[0]).toMatchObject({ framework: "express", file: "src/server.ts", method: "GET" });
    });

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/ready");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers).toContainEqual(expect.objectContaining({ framework: "express" }));
    });
  });

  it("resolves a Yii2 controller action by convention", async () => {
    const controllerId = "test:controllers/SiteController.php:SiteController:1";
    const index = makeIndex(
      [{ path: "controllers/SiteController.php", language: "php" }],
      [
        { id: controllerId, name: "SiteController", kind: "class", file: "controllers/SiteController.php" },
        { name: "actionIndex", kind: "method", file: "controllers/SiteController.php", parent: controllerId },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/site");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers).toContainEqual(expect.objectContaining({ framework: "yii2", method: "GET" }));
    });
  });

  it("preserves the HTTP verb from a Yii2 URL rule", async () => {
    await mkdir(join(tmpRoot, "config"), { recursive: true });
    await writeFile(
      join(tmpRoot, "config/web.php"),
      `<?php return ['urlManager' => ['rules' => ['POST api/users' => 'user/create']]];`,
    );
    const controllerId = "test:controllers/UserController.php:UserController:1";
    const index = {
      ...makeIndex(
        [
          { path: "config/web.php", language: "php" },
          { path: "controllers/UserController.php", language: "php" },
        ],
        [
          { id: controllerId, name: "UserController", kind: "class", file: "controllers/UserController.php" },
          { name: "actionCreate", kind: "method", file: "controllers/UserController.php", parent: controllerId },
        ],
      ),
      root: tmpRoot,
    };
    await withIndex(index, async () => {
      const result = await traceRoute("test", "/api/users");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers).toContainEqual(expect.objectContaining({ framework: "yii2", method: "POST" }));
    });
  });

  it("finds Laravel, Ktor, Spring Kotlin, and Django routes from real files", async () => {
    const repo = await createIndexedFixture({
      "routes/api.php": `<?php
Route::post('/orders', [OrderController::class, 'store']);`,
      "src/Application.kt": `fun Application.routes() {
  routing {
    get("/health") { call.respondText("ok") }
  }
}`,
      "src/UserController.kt": `@RestController
@RequestMapping("/users")
class UserController {
  @GetMapping("/{id}")
  fun show(): String = "ok"
}`,
      "myapp/urls.py": `from django.urls import path
from . import views
urlpatterns = [path('posts/<int:id>/', views.detail)]`,
      "myapp/views.py": `def detail(request, id):
    return id`,
    });

    const laravel = await traceRoute(repo, "/orders");
    const ktor = await traceRoute(repo, "/health");
    const spring = await traceRoute(repo, "/users/42");
    const django = await traceRoute(repo, "/posts/42/");

    for (const result of [laravel, ktor, spring, django]) {
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
    }
    expect(laravel.handlers).toContainEqual(expect.objectContaining({ framework: "laravel", method: "POST" }));
    expect(ktor.handlers).toContainEqual(expect.objectContaining({ framework: "ktor", method: "GET" }));
    expect(spring.handlers).toContainEqual(expect.objectContaining({ framework: "spring-kotlin", method: "GET" }));
    expect(django.handlers).toContainEqual(expect.objectContaining({ framework: "django" }));
  });

  it("joins nested Ktor prefixes that omit leading slashes", async () => {
    const repo = await createIndexedFixture({
      "src/Application.kt": `fun Application.routes() {
  routing {
    route("api") {
      route("v1") {
        get("users") { call.respondText("ok") }
      }
    }
  }
}`,
    });
    const result = await traceRoute(repo, "/api/v1/users");
    if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
    expect(result.handlers).toContainEqual(expect.objectContaining({ framework: "ktor", method: "GET" }));
  });

  it("resolves Django class-based views instead of the as_view adapter", async () => {
    const repo = await createIndexedFixture({
      "myapp/urls.py": `from django.urls import path
from . import views
urlpatterns = [path('users/', views.UserList.as_view())]`,
      "myapp/views.py": `class UserList:
  pass`,
    });
    const result = await traceRoute(repo, "/users/");
    if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
    expect(result.handlers).toContainEqual(expect.objectContaining({
      framework: "django",
      file: "myapp/views.py",
      symbol: expect.objectContaining({ name: "UserList" }),
    }));
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
      expect(result.handlers).toContainEqual(expect.objectContaining({
        framework: "astro",
        file: "src/pages/blog/[slug].astro",
      }));
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
      expect(result.handlers).toContainEqual(expect.objectContaining({
        framework: "astro",
        file: "src/pages/api/data.ts",
        method: "GET",
      }));
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
    expect(result.handlers).toContainEqual(expect.objectContaining({
      symbol: expect.objectContaining({ name: "POST" }),
    }));
  });

  it("still finds handler in route.ts file (regression)", async () => {
    const repo = await createIndexedFixture({
      "app/api/users/route.ts": `import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ users: [] });
}`,
    });
    const result = await traceRoute(repo, "/api/users");
    expect(result.handlers).toContainEqual(expect.objectContaining({
      symbol: expect.objectContaining({ name: "GET" }),
    }));
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
    expect(result.handlers).toContainEqual(expect.objectContaining({ router: "pages" }));
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
    expect(result.handlers).toHaveLength(2);
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
    expect(result.handlers).toContainEqual(expect.objectContaining({ router: "pages" }));
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
    expect(result.middleware).toEqual(expect.objectContaining({
      applies: true,
      matchers: ["/api/:path*"],
    }));
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
    expect(result.middleware).toEqual(expect.objectContaining({ applies: false }));
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
    expect(result.server_actions).toContainEqual(expect.objectContaining({ name: "updateUser" }));
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
    expect(result.handlers).toContainEqual(expect.objectContaining({
      framework: "hono",
      method: "GET",
    }));
  });

  it("traces Hono parameterized path (AC-R1 with param)", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
export default app;`,
    });
    const result = await traceRoute(repo, "/users/:id");
    expect(result.handlers).toContainEqual(expect.objectContaining({ framework: "hono" }));
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
