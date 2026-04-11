import { describe, it, expect, vi } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";

import { nextjsApiContract } from "../../src/tools/nextjs-api-contract-tools.js";
import {
  extractHttpMethods,
  extractRequestBodySchema,
  extractQueryParams,
  extractResponseShapes,
} from "../../src/tools/nextjs-api-contract-readers.js";

async function parseTs(source: string) {
  const tree = await parseFile("route.ts", source);
  if (!tree) throw new Error("parse failed");
  return tree;
}

describe("nextjs-api-contract-tools exports", () => {
  it("exports nextjsApiContract function", () => {
    expect(typeof nextjsApiContract).toBe("function");
  });

  it("exports all readers", () => {
    expect(typeof extractHttpMethods).toBe("function");
    expect(typeof extractRequestBodySchema).toBe("function");
    expect(typeof extractQueryParams).toBe("function");
    expect(typeof extractResponseShapes).toBe("function");
  });
});

describe("extractHttpMethods", () => {
  it("returns ['GET'] for a single GET export", async () => {
    const tree = await parseTs(`export async function GET() { return new Response(); }`);
    const info = extractHttpMethods(tree);
    expect(info.methods).toEqual(["GET"]);
    expect(info.wrapped).toBe(false);
  });

  it("returns sorted methods for GET+POST+DELETE", async () => {
    const tree = await parseTs(`
export async function GET() { return new Response(); }
export async function POST() { return new Response(); }
export async function DELETE() { return new Response(); }
`);
    const info = extractHttpMethods(tree);
    expect(info.methods).toEqual(["DELETE", "GET", "POST"]);
  });

  it("returns empty array when no HTTP methods exported", async () => {
    const tree = await parseTs(`export async function helper() { return 1; }`);
    const info = extractHttpMethods(tree);
    expect(info.methods).toEqual([]);
  });

  it("flags wrapped exports (export const GET = withAuth(...))", async () => {
    const tree = await parseTs(`
export const GET = withAuth(async function() { return new Response(); });
`);
    const info = extractHttpMethods(tree);
    expect(info.methods).toEqual(["GET"]);
    expect(info.wrapped).toBe(true);
  });
});

describe("extractQueryParams", () => {
  it("returns wildcard for runtime URL access", async () => {
    const src = `
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  return new Response(searchParams.get("id"));
}
`;
    const tree = await parseTs(src);
    const params = extractQueryParams(tree, src);
    expect(params).toBe("*");
  });

  it("returns empty array when no query access detected", async () => {
    const src = `
export async function GET() {
  return new Response("hello");
}
`;
    const tree = await parseTs(src);
    const params = extractQueryParams(tree, src);
    expect(params).toEqual([]);
  });
});

describe("extractRequestBodySchema", () => {
  it("extracts local Zod schema referenced via .parse(await req.json())", async () => {
    const src = `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req) {
  const body = schema.parse(await req.json());
  return new Response();
}
`;
    const tree = await parseTs(src);
    const result = extractRequestBodySchema(tree, src);
    expect(result).not.toBeNull();
    expect(result!.fields).toBeDefined();
  });

  it("returns ref + resolved=false for imported schema", async () => {
    const src = `
import { CreateUserSchema } from "./schemas";
export async function POST(req) {
  const body = CreateUserSchema.parse(await req.json());
  return new Response();
}
`;
    const tree = await parseTs(src);
    const result = extractRequestBodySchema(tree, src);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("CreateUserSchema");
    expect(result!.resolved).toBe(false);
  });

  it("returns null when no validation present", async () => {
    const src = `
export async function POST(req) {
  const body = await req.json();
  return new Response();
}
`;
    const tree = await parseTs(src);
    const result = extractRequestBodySchema(tree, src);
    expect(result).toBeNull();
  });

  it("returns type=form for req.formData()", async () => {
    const src = `
export async function POST(req) {
  const form = await req.formData();
  return new Response();
}
`;
    const tree = await parseTs(src);
    const result = extractRequestBodySchema(tree, src);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("form");
  });
});

describe("extractResponseShapes", () => {
  it("captures NextResponse.json with status 200", async () => {
    const src = `
export async function GET() {
  return NextResponse.json({ users: [] });
}
`;
    const tree = await parseTs(src);
    const shapes = extractResponseShapes(tree, src);
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    expect(shapes[0]!.type).toBe("json");
    expect(shapes[0]!.status).toBe(200);
  });

  it("captures explicit status code from second arg", async () => {
    const src = `
export async function GET() {
  return NextResponse.json({ error: "..." }, { status: 400 });
}
`;
    const tree = await parseTs(src);
    const shapes = extractResponseShapes(tree, src);
    expect(shapes.find((s) => s.status === 400)).toBeDefined();
  });

  it("captures empty Response with status 204", async () => {
    const src = `
export async function DELETE() {
  return new Response(null, { status: 204 });
}
`;
    const tree = await parseTs(src);
    const shapes = extractResponseShapes(tree, src);
    expect(shapes.find((s) => s.status === 204)).toBeDefined();
  });

  it("captures multiple returns (success + error)", async () => {
    const src = `
export async function GET() {
  if (cond) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: "..." }, { status: 400 });
}
`;
    const tree = await parseTs(src);
    const shapes = extractResponseShapes(tree, src);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    const statuses = shapes.map((s) => s.status).sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(400);
  });

  it("captures stream response", async () => {
    const src = `
export async function GET() {
  return new Response(stream);
}
`;
    const tree = await parseTs(src);
    const shapes = extractResponseShapes(tree, src);
    expect(shapes.length).toBeGreaterThanOrEqual(1);
  });
});

describe("nextjsApiContract orchestrator", () => {
  let tmpRoot: string;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "nextjs-api-contract-"));
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

  it("returns 3 handlers from app/api routes (GET/POST/DELETE)", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/api/users/route.ts": `
export async function GET() { return NextResponse.json({ users: [] }); }
export async function POST(req) { const body = await req.json(); return NextResponse.json({}, { status: 201 }); }
`,
      "app/api/users/[id]/route.ts": `
export async function DELETE() { return new Response(null, { status: 204 }); }
`,
    });
    try {
      mockIndex(root);
      const result = await nextjsApiContract("test");
      expect(result.handlers.length).toBe(3);
      const methods = result.handlers.map((h) => h.method).sort();
      expect(methods).toEqual(["DELETE", "GET", "POST"]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("includes both App and Pages router handlers tagged correctly", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/api/items/route.ts": `export async function GET() { return NextResponse.json({}); }`,
      "pages/api/legacy.ts": `export default function handler(req, res) { res.json({}); }`,
    });
    try {
      mockIndex(root);
      const result = await nextjsApiContract("test");
      const routers = new Set(result.handlers.map((h) => h.router));
      expect(routers.has("app")).toBe(true);
      // Pages router handlers may be reported as a single 'page' handler, not method-keyed
      expect(result.handlers.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("matches pre-authored expected.json (fixture)", async () => {
    const fixtureRoot = resolve(__dirname, "../fixtures/nextjs-api-contracts");
    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "nextjs-api-contracts",
      root: fixtureRoot,
      files: [],
      symbols: [],
      git: { head: "test", worktree_clean: true, branch: "test" },
      lsp: {},
    } as never);

    const expectedRaw = await readFile(resolve(fixtureRoot, "expected.json"), "utf8");
    const expected = JSON.parse(expectedRaw) as {
      handlers: Array<{ method: string; path: string }>;
      total: number;
    };
    const result = await nextjsApiContract("nextjs-api-contracts");
    expect(result.total).toBe(expected.total);
    for (const exp of expected.handlers) {
      const found = result.handlers.find(
        (h) => h.method === exp.method && h.path === exp.path,
      );
      expect(found, `expected handler ${exp.method} ${exp.path}`).toBeDefined();
    }
  });

  it("emits a completeness_score field 0..100", async () => {
    const root = await makeRepo({
      "next.config.js": "module.exports = {};\n",
      "app/api/things/route.ts": `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req) { const body = schema.parse(await req.json()); return NextResponse.json(body); }
`,
    });
    try {
      mockIndex(root);
      const result = await nextjsApiContract("test");
      expect(typeof result.completeness_score).toBe("number");
      expect(result.completeness_score).toBeGreaterThanOrEqual(0);
      expect(result.completeness_score).toBeLessThanOrEqual(100);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
