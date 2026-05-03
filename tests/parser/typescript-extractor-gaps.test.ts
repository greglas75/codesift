import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { extractTypeScriptSymbols } from "../../src/parser/extractors/typescript.js";
import { getParser } from "../../src/parser/parser-manager.js";

let tsParser: Parser;
let tsxParser: Parser;

beforeAll(async () => {
  const a = await getParser("typescript");
  const b = await getParser("tsx");
  if (!a || !b) throw new Error("ts/tsx parser unavailable");
  tsParser = a;
  tsxParser = b;
});

function ext(source: string, lang: "ts" | "tsx" = "ts") {
  const parser = lang === "tsx" ? tsxParser : tsParser;
  const tree = parser.parse(source);
  const file = lang === "tsx" ? "f.tsx" : "f.ts";
  return extractTypeScriptSymbols(tree, file, source, "test-repo");
}

describe("L4 heritage — extends / implements", () => {
  it("captures extends Foo as identifier (standard ES6 inheritance)", () => {
    const syms = ext(`class A extends Foo {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.extends).toEqual(["Foo"]);
    expect(cls?.implements).toBeUndefined();
  });

  it("captures extends Bar implements Baz<T> with type-arg stripped", () => {
    const syms = ext(`class A extends Bar implements Baz<T> {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.extends).toEqual(["Bar"]);
    expect(cls?.implements).toEqual(["Baz"]);
  });

  it("preserves qualified names (extends ns.Base)", () => {
    const syms = ext(`class A extends ns.Base {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.extends).toEqual(["ns.Base"]);
  });

  it("expands intersection type implements I & J", () => {
    const syms = ext(`class A implements I & J {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.implements).toEqual(["I", "J"]);
  });

  it("expands multiple implements clauses (implements I, J)", () => {
    const syms = ext(`class A implements I, J {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.implements).toEqual(["I", "J"]);
  });

  it("preserves React class component detection (extends React.Component)", () => {
    const syms = ext(`class MyComp extends React.Component { render() { return null; } }`);
    const cls = syms.find((s) => s.name === "MyComp");
    expect(cls?.kind).toBe("component");
    expect(cls?.extends).toEqual(["React.Component"]);
  });

  it("preserves bare PureComponent React detection", () => {
    const syms = ext(`class C extends PureComponent { render() { return null; } }`);
    const cls = syms.find((s) => s.name === "C");
    expect(cls?.kind).toBe("component");
  });

  it(".tsx parity: same heritage extraction in TSX", () => {
    const syms = ext(`class C extends Base implements I {}`, "tsx");
    const cls = syms.find((s) => s.name === "C");
    expect(cls?.extends).toEqual(["Base"]);
    expect(cls?.implements).toEqual(["I"]);
  });

  it("class with no heritage produces no extends/implements", () => {
    const syms = ext(`class A {}`);
    const cls = syms.find((s) => s.name === "A");
    expect(cls?.extends).toBeUndefined();
    expect(cls?.implements).toBeUndefined();
  });
});
