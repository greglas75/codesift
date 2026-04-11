import { describe, it, expect, vi } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

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
