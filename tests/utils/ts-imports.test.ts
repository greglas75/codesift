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

  // Empty named-imports clause still loads the target module at runtime.
  it("treats empty named-imports clause `import { } from \"y\"` as runtime", () => {
    const edges = extract(`import { } from "./y";`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ path: "./y", is_type_only: false, specifiers: [] });
  });

  it("flags `import type { } from \"y\"` as type_only despite empty clause", () => {
    const edges = extract(`import type { } from "./y";`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ path: "./y", is_type_only: true, specifiers: [] });
  });

  it("captures default + named imports as runtime", () => {
    const edges = extract(`import Default, { Named } from "./y";`);
    expect(edges[0]?.is_type_only).toBe(false);
    expect(edges[0]?.specifiers).toContain("Default");
    expect(edges[0]?.specifiers).toContain("Named");
  });

  it("captures `import x = require(\"./y\")` as runtime", () => {
    const edges = extract(`import x = require("./y");`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      path: "./y",
      is_type_only: false,
      specifiers: ["x"],
    });
  });

  it("flags `export { type Foo } from \"y\"` as type_only when every specifier is typed", () => {
    const edges = extract(`export { type Foo } from "./y";`);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      path: "./y",
      is_type_only: true,
      specifiers: ["Foo"],
    });
  });

  it("flags statement-level `export type { Foo } from \"y\"` as type_only", () => {
    const edges = extract(`export type { Foo } from "./y";`);
    expect(edges[0]).toMatchObject({ path: "./y", is_type_only: true });
  });

  it("treats mixed `export { type A, B } from \"y\"` as runtime", () => {
    const edges = extract(`export { type A, B } from "./y";`);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.is_type_only).toBe(false);
    expect(edges[0]?.specifiers).toEqual(["A", "B"]);
  });

  it("treats plain `export { Foo } from \"y\"` re-export as runtime", () => {
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

// Dependencies that no `import` statement declares.
//
// The AST walker is authoritative for .ts/.tsx — the regex collector that catches `import()` and
// `require()` runs only when the parser fails — so anything missing here is missing from the graph
// entirely. Measured on tgm-survey-platform before this: 576 dynamic imports and 1,708 mocks
// resolved to an indexed file and produced no edge.
describe("extractTypeScriptImports — calls that name a module", () => {
  let parser: Parser;

  beforeAll(async () => {
    const p = await getParser("typescript");
    if (!p) throw new Error("typescript parser unavailable");
    parser = p;
  });

  const extract = (src: string) => extractTypeScriptImports(parser.parse(src));

  it("records `await import(\"./y\")` as a runtime dependency", () => {
    const edges = extract(`async function f() { const m = await import("./y"); return m; }`);
    expect(edges).toEqual([
      { path: "./y", kind: "dynamic", is_type_only: false, specifiers: [] },
    ]);
  });

  it("records the import inside `import(\"./y\").then(…)`", () => {
    // The outer call_expression's function is a member_expression; returning at the outer node
    // would drop the real one nested inside it.
    expect(extract(`import("./y").then((m) => m);`)).toEqual([
      { path: "./y", kind: "dynamic", is_type_only: false, specifiers: [] },
    ]);
  });

  it("treats `typeof import(\"./y\")` as type-only — the module is named, never loaded", () => {
    expect(extract(`type M = typeof import("./y");`)[0]).toMatchObject({
      path: "./y",
      kind: "dynamic",
      is_type_only: true,
    });
  });

  it("records a `require(\"./y\")` call", () => {
    expect(extract(`const y = require("./y");`)).toEqual([
      { path: "./y", kind: "require", is_type_only: false, specifiers: [] },
    ]);
  });

  it("records vi.mock and jest.mock as `mock`, not as imports", () => {
    const edges = extract(`vi.mock("./a", () => ({})); jest.mock("./b");`);
    expect(edges.map((e) => [e.path, e.kind])).toEqual([
      ["./a", "mock"],
      ["./b", "mock"],
    ]);
  });

  it("skips a specifier it cannot know: `import(someVariable)`", () => {
    // A guess here would be worse than the gap — it would attach the edge to whichever file
    // happened to match, and nothing downstream could tell that apart from a real import.
    expect(extract(`async function f(p: string) { await import(p); }`)).toEqual([]);
    expect(extract('await import(`./${name}`);')).toEqual([]);
  });

  it("still labels ordinary imports `static`", () => {
    expect(extract(`import { X } from "./y";`)[0]?.kind).toBe("static");
    expect(extract(`export { X } from "./y";`)[0]?.kind).toBe("static");
    expect(extract(`import x = require("./y");`)[0]?.kind).toBe("static");
  });
});
