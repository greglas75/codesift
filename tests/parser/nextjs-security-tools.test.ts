import { describe, it, expect, vi } from "vitest";
import { parseFile } from "../../src/parser/parser-manager.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { nextjsAuditServerActions } from "../../src/tools/nextjs-security-tools.js";
import {
  extractServerActionFunctions,
  detectAuthGuard,
  detectInputValidation,
  detectRateLimiting,
} from "../../src/tools/nextjs-security-readers.js";
import { scoreServerAction } from "../../src/tools/nextjs-security-scoring.js";

async function parseTs(source: string) {
  const tree = await parseFile("x.ts", source);
  if (!tree) throw new Error("parse failed");
  return tree;
}

describe("nextjs-security-tools exports", () => {
  it("exports nextjsAuditServerActions function", () => {
    expect(typeof nextjsAuditServerActions).toBe("function");
  });

  it("exports extractServerActionFunctions reader", () => {
    expect(typeof extractServerActionFunctions).toBe("function");
  });

  it("exports detection readers", () => {
    expect(typeof detectAuthGuard).toBe("function");
    expect(typeof detectInputValidation).toBe("function");
    expect(typeof detectRateLimiting).toBe("function");
  });

  it("exports scoreServerAction", () => {
    expect(typeof scoreServerAction).toBe("function");
  });
});

describe("extractServerActionFunctions", () => {
  it("returns 3 entries for file-scope 'use server' with 3 exported async functions", async () => {
    const src = `"use server";
export async function a() {}
export async function b() {}
export async function c() {}
`;
    const tree = await parseTs(src);
    const fns = extractServerActionFunctions(tree, src, "actions.ts");
    expect(fns.length).toBe(3);
    const names = fns.map((f) => f.name).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when no 'use server' present", async () => {
    const src = `export async function notAnAction() {}`;
    const tree = await parseTs(src);
    const fns = extractServerActionFunctions(tree, src, "regular.ts");
    expect(fns.length).toBe(0);
  });

  it("captures inline 'use server' functions", async () => {
    const src = `export async function inlineAction() {
  "use server";
  return 1;
}
export async function notAction() {
  return 2;
}
`;
    const tree = await parseTs(src);
    const fns = extractServerActionFunctions(tree, src, "mixed.ts");
    expect(fns.length).toBe(1);
    expect(fns[0]!.name).toBe("inlineAction");
  });

  it("captures non-async functions in file-scope 'use server' file", async () => {
    const src = `"use server";
export function syncAction() { return 1; }
export async function asyncAction() { return 2; }
`;
    const tree = await parseTs(src);
    const fns = extractServerActionFunctions(tree, src, "sync.ts");
    expect(fns.length).toBe(2);
    const sync = fns.find((f) => f.name === "syncAction");
    expect(sync).toBeDefined();
    expect(sync!.isAsync).toBe(false);
  });
});
