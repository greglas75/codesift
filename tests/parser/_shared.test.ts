import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { makeSymbol } from "../../src/parser/extractors/_shared.js";
import { getParser } from "../../src/parser/parser-manager.js";

describe("makeSymbol — implements field plumbing", () => {
  let parser: Parser;

  beforeAll(async () => {
    const p = await getParser("typescript");
    if (!p) throw new Error("typescript parser unavailable");
    parser = p;
  });

  function buildNode(source: string): Parser.SyntaxNode {
    const tree = parser.parse(source);
    return tree.rootNode.namedChildren[0]!;
  }

  it("propagates implements array when present", () => {
    const node = buildNode("class Foo {}");
    const sym = makeSymbol(node, "Foo", "class", "f.ts", "class Foo {}", "r", {
      implements: ["Bar", "Baz"],
    });
    expect(sym.implements).toEqual(["Bar", "Baz"]);
  });

  it("omits implements when empty array given", () => {
    const node = buildNode("class Foo {}");
    const sym = makeSymbol(node, "Foo", "class", "f.ts", "class Foo {}", "r", {
      implements: [],
    });
    expect(sym.implements).toBeUndefined();
  });

  it("omits implements when not provided", () => {
    const node = buildNode("class Foo {}");
    const sym = makeSymbol(node, "Foo", "class", "f.ts", "class Foo {}", "r", {});
    expect(sym.implements).toBeUndefined();
  });

  it("does not affect extends field", () => {
    const node = buildNode("class Foo {}");
    const sym = makeSymbol(node, "Foo", "class", "f.ts", "class Foo {}", "r", {
      extends: ["Base"],
      implements: ["I"],
    });
    expect(sym.extends).toEqual(["Base"]);
    expect(sym.implements).toEqual(["I"]);
  });

  it("copies extends and implements so caller mutations do not affect the symbol", () => {
    const node = buildNode("class Foo {}");
    const ext = ["Base"];
    const impl = ["I"];
    const sym = makeSymbol(node, "Foo", "class", "f.ts", "class Foo {}", "r", {
      extends: ext,
      implements: impl,
    });
    ext.push("Other");
    impl.push("J");
    expect(sym.extends).toEqual(["Base"]);
    expect(sym.implements).toEqual(["I"]);
  });
});
