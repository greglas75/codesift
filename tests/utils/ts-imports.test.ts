import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { extractTypeScriptImports } from "../../src/utils/ts-imports.js";
import { getParser } from "../../src/parser/parser-manager.js";

describe("extractTypeScriptImports", () => {
  let parser: Parser;

  beforeAll(async () => {
    const p = await getParser("typescript");
    if (!p) throw new Error("typescript parser unavailable");
    parser = p;
  });

  function extract(src: string) {
    const tree = parser.parse(src);
    return extractTypeScriptImports(tree);
  }

  it("flags `import type { X } from \"y\"` as type_only", () => {
    const edges = extract(`import type { Foo } from "./y";`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ path: "./y", is_type_only: true, specifiers: ["Foo"] });
  });

  it("flags mixed `import { type X, Y }` as runtime (any runtime specifier)", () => {
    const edges = extract(`import { type X, Y } from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
    expect(edges[0]?.specifiers).toEqual(["X", "Y"]);
  });

  it("treats plain `import { X } from \"y\"` as runtime", () => {
    const edges = extract(`import { Foo } from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
  });

  it("treats namespace import `import * as ns from \"y\"` as runtime", () => {
    const edges = extract(`import * as ns from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
    expect(edges[0]?.specifiers).toEqual(["ns"]);
  });

  it("captures side-effect import with empty specifiers", () => {
    const edges = extract(`import "./side-effect";`);
    expect(edges[0]).toMatchObject({ path: "./side-effect", is_type_only: false, specifiers: [] });
  });

  it("captures default + named imports as runtime", () => {
    const edges = extract(`import Default, { Named } from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
    expect(edges[0]?.specifiers).toContain("Default");
    expect(edges[0]?.specifiers).toContain("Named");
  });

  it("flags `export type { X } from \"y\"` re-export as type_only", () => {
    const edges = extract(`export type { Foo } from "./y";`);
    expect(edges[0]).toMatchObject({ path: "./y", is_type_only: true });
  });

  it("treats plain `export { X } from \"y\"` re-export as runtime", () => {
    const edges = extract(`export { Foo } from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
  });

  it("captures `export * from \"y\"` as runtime re-export", () => {
    const edges = extract(`export * from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
  });

  it("captures `export type * from \"y\"` as type-only re-export", () => {
    const edges = extract(`export type * from "./y";`);
    expect(edges[0]?.is_type_only).toBe(true);
  });

  it("returns empty array for files with no imports", () => {
    const edges = extract(`function foo() { return 1; }`);
    expect(edges).toHaveLength(0);
  });

  it("ignores local exports without `from` clause", () => {
    const edges = extract(`export const x = 1; export { x };`);
    expect(edges).toHaveLength(0);
  });
});
