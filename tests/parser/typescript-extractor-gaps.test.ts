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

describe("L7 generics in signature", () => {
  it("captures function generics with constraints", () => {
    const syms = ext(`function identity<T extends Foo>(x: T): T { return x; }`);
    const fn = syms.find((s) => s.name === "identity");
    expect(fn?.signature).toContain("<T extends Foo>");
    expect(fn?.signature).toContain("(x: T)");
    expect(fn?.signature).toContain(": T");
  });

  it("captures default-parameter generics", () => {
    const syms = ext(`function box<T = string>(x: T) { return x; }`);
    const fn = syms.find((s) => s.name === "box");
    expect(fn?.signature).toContain("<T = string>");
  });

  it("captures multi-parameter generics", () => {
    const syms = ext(`function map<K, V>(k: K, v: V): V { return v; }`);
    const fn = syms.find((s) => s.name === "map");
    expect(fn?.signature).toContain("<K, V>");
  });

  it("captures method generics inside a class", () => {
    const syms = ext(`class C { id<T>(x: T): T { return x; } }`);
    const m = syms.find((s) => s.name === "id");
    expect(m?.signature).toContain("<T>");
  });

  it("function without generics still produces clean signature (no double-colon)", () => {
    const syms = ext(`function plain(x: number): number { return x; }`);
    const fn = syms.find((s) => s.name === "plain");
    expect(fn?.signature).toBe("(x: number): number");
    // Regression guard: no `: : ` from old buggy prepend.
    expect(fn?.signature).not.toContain(": : ");
  });

  it(".tsx parity: generics extracted in TSX", () => {
    const syms = ext(`function Wrap<T>(p: T) { return p; }`, "tsx");
    const fn = syms.find((s) => s.name === "Wrap");
    expect(fn?.signature).toContain("<T>");
  });
});

describe("L3 enum members", () => {
  it("emits enum container + named members as constants", () => {
    const syms = ext(`enum Direction { North = 1, South }`);
    const enumSym = syms.find((s) => s.name === "Direction" && s.kind === "enum");
    const north = syms.find((s) => s.name === "North");
    const south = syms.find((s) => s.name === "South");
    expect(enumSym).toBeDefined();
    expect(north?.kind).toBe("constant");
    expect(south?.kind).toBe("constant");
    expect(north?.parent).toBe(enumSym?.id);
    expect(south?.parent).toBe(enumSym?.id);
  });

  it("handles bare property_identifier members (no value)", () => {
    const syms = ext(`enum Color { Red, Green, Blue }`);
    const members = syms.filter((s) => s.kind === "constant" && s.name !== "Color");
    expect(members.map((m) => m.name)).toEqual(["Red", "Green", "Blue"]);
  });

  it("handles string-valued enum members", () => {
    const syms = ext(`enum Status { Open = "open", Closed = "closed" }`);
    const enumSym = syms.find((s) => s.kind === "enum");
    const constants = syms.filter((s) => s.kind === "constant" && s.parent === enumSym?.id);
    expect(constants.map((c) => c.name)).toEqual(["Open", "Closed"]);
  });

  it("respects exported enum (members inherit no is_exported but parent does)", () => {
    const syms = ext(`export enum K { A, B }`);
    const enumSym = syms.find((s) => s.kind === "enum");
    expect(enumSym?.is_exported).toBe(true);
  });

  it(".tsx parity: enum members extracted in TSX", () => {
    const syms = ext(`enum E { Foo, Bar }`, "tsx");
    const constants = syms.filter((s) => s.kind === "constant");
    expect(constants.map((c) => c.name)).toEqual(["Foo", "Bar"]);
  });
});

describe("L5 is_async flag", () => {
  it("sets is_async on async function declaration", () => {
    const syms = ext(`async function foo() {}`);
    const fn = syms.find((s) => s.name === "foo");
    expect(fn?.is_async).toBe(true);
  });

  it("does NOT set is_async on sync function", () => {
    const syms = ext(`function foo() {}`);
    const fn = syms.find((s) => s.name === "foo");
    expect(fn?.is_async).toBeUndefined();
  });

  it("sets is_async on async arrow assigned to const", () => {
    const syms = ext(`const fetch = async () => {};`);
    const fn = syms.find((s) => s.name === "fetch");
    expect(fn?.is_async).toBe(true);
  });

  it("sets is_async on async method inside class", () => {
    const syms = ext(`class C { async run() {} sync() {} }`);
    const asyncM = syms.find((s) => s.name === "run");
    const syncM = syms.find((s) => s.name === "sync");
    expect(asyncM?.is_async).toBe(true);
    expect(syncM?.is_async).toBeUndefined();
  });

  it(".tsx parity: is_async on async functions in TSX", () => {
    const syms = ext(`async function foo() { return 1; }`, "tsx");
    const fn = syms.find((s) => s.name === "foo");
    expect(fn?.is_async).toBe(true);
  });
});

describe("L8 modifiers + L9 accessor kind", () => {
  it("captures static + readonly on class field", () => {
    const syms = ext(`class C { static readonly x: number = 1; }`);
    const f = syms.find((s) => s.name === "x");
    const mods = (f?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("static");
    expect(mods).toContain("readonly");
  });

  it("captures accessibility modifier (private)", () => {
    const syms = ext(`class C { private foo() {} }`);
    const m = syms.find((s) => s.name === "foo");
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("private");
  });

  it("captures override + protected on method", () => {
    const syms = ext(`class C extends B { protected override greet() {} }`);
    const m = syms.find((s) => s.name === "greet");
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("protected");
    expect(mods).toContain("override");
  });

  it("records abstract on abstract_method_signature", () => {
    const syms = ext(`abstract class C { abstract foo(): void; }`);
    const m = syms.find((s) => s.name === "foo");
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("abstract");
  });

  it("L9: getter is detected as accessor_kind=get", () => {
    const syms = ext(`class C { get name() { return ""; } }`);
    const m = syms.find((s) => s.name === "name");
    expect(m?.meta?.["accessor_kind"]).toBe("get");
  });

  it("L9: setter is detected as accessor_kind=set", () => {
    const syms = ext(`class C { set name(v: string) {} }`);
    const m = syms.find((s) => s.name === "name");
    expect(m?.meta?.["accessor_kind"]).toBe("set");
  });

  it(".tsx parity: modifiers captured in TSX", () => {
    const syms = ext(`class C { private foo() {} }`, "tsx");
    const m = syms.find((s) => s.name === "foo");
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("private");
  });
});
