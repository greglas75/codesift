import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { traceMiddleware } from "../../src/utils/nextjs.js";

let tmpDir: string;

async function createFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-nextjs-mw-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(tmpDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

describe("traceMiddleware", () => {
  it("returns applies=true when literal matcher matches path", async () => {
    const root = await createFixture({
      "middleware.ts": `
import { NextResponse } from "next/server";

export const config = {
  matcher: "/api/:path*",
};

export function middleware(req) {
  return NextResponse.next();
}
`,
    });
    const result = await traceMiddleware(root, "/api/users");
    expect(result).not.toBeNull();
    expect(result!.applies).toBe(true);
    expect(result!.matchers).toEqual(["/api/:path*"]);
  });

  it("returns applies=false when literal matcher array does not match path", async () => {
    const root = await createFixture({
      "middleware.ts": `
import { NextResponse } from "next/server";

export const config = {
  matcher: ["/admin/:path*"],
};

export function middleware(req) {
  return NextResponse.next();
}
`,
    });
    const result = await traceMiddleware(root, "/api/users");
    expect(result).not.toBeNull();
    expect(result!.applies).toBe(false);
    expect(result!.matchers).toEqual(["/admin/:path*"]);
  });

  it("returns applies=true (fail-open) when matcher is computed", async () => {
    const root = await createFixture({
      "middleware.ts": `
import { NextResponse } from "next/server";

const computedVal = getMatchers();

export const config = {
  matcher: computedVal,
};

export function middleware(req) {
  return NextResponse.next();
}
`,
    });
    const result = await traceMiddleware(root, "/api/users");
    expect(result).not.toBeNull();
    expect(result!.applies).toBe(true);
    expect(result!.matchers).toEqual(["<computed>"]);
  });

  it("returns applies=true (fail-open) when no config export exists", async () => {
    const root = await createFixture({
      "middleware.ts": `
import { NextResponse } from "next/server";

export function middleware(req) {
  return NextResponse.next();
}
`,
    });
    const result = await traceMiddleware(root, "/api/users");
    expect(result).not.toBeNull();
    expect(result!.applies).toBe(true);
    expect(result!.matchers).toEqual([]);
  });

  it("returns null when no middleware file exists", async () => {
    const root = await createFixture({
      "app/page.tsx": `export default function Home() { return <div/>; }`,
    });
    const result = await traceMiddleware(root, "/");
    expect(result).toBeNull();
  });
});
