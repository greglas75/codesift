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
