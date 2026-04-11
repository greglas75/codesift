import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { traceRoute } from "../../src/tools/route-tools.js";
import { resetConfigCache } from "../../src/config.js";

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
      "pages/api/exotic.ts": `const h = (req, res) => {
  res.status(200).json({ ok: true });
};
export default h;`,
    });
    const result = await traceRoute(repo, "/api/exotic");
    expect(result.handlers.length).toBeGreaterThanOrEqual(1);
  });
});
