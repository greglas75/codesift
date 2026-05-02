import { describe, it, expectTypeOf } from "vitest";
import type { CodeSymbol } from "../../src/types.js";

describe("CodeSymbol schema", () => {
  it("accepts implements field as string[]", () => {
    const sym: CodeSymbol = {
      id: "repo:file:Foo:1",
      repo: "repo",
      name: "Foo",
      kind: "class",
      file: "file.ts",
      start_line: 1,
      end_line: 10,
      implements: ["Bar", "Baz"],
    };
    expectTypeOf(sym.implements).toEqualTypeOf<string[] | undefined>();
  });

  it("treats implements as optional", () => {
    const sym: CodeSymbol = {
      id: "repo:file:Foo:1",
      repo: "repo",
      name: "Foo",
      kind: "class",
      file: "file.ts",
      start_line: 1,
      end_line: 10,
    };
    expectTypeOf(sym.implements).toEqualTypeOf<string[] | undefined>();
  });

  it("preserves symmetry with extends field", () => {
    const sym: CodeSymbol = {
      id: "repo:file:Foo:1",
      repo: "repo",
      name: "Foo",
      kind: "class",
      file: "file.ts",
      start_line: 1,
      end_line: 10,
      extends: ["BaseController"],
      implements: ["Loggable"],
    };
    expectTypeOf(sym.extends).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(sym.implements).toEqualTypeOf<string[] | undefined>();
  });
});
