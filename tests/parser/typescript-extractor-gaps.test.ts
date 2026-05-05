import { describe, it, expect, beforeAll, vi } from "vitest";
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

  it("abstract_method_signature sets is_async for abstract async method", () => {
    const syms = ext(`abstract class C { abstract async fetch(): Promise<void>; }`);
    const m = syms.find((s) => s.name === "fetch");
    expect(m?.is_async).toBe(true);
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("abstract");
  });

  it("abstract_method_signature sets accessor_kind for abstract getter", () => {
    const syms = ext(`abstract class C { abstract get label(): string; }`);
    const m = syms.find((s) => s.name === "label");
    expect(m?.meta?.["accessor_kind"]).toBe("get");
    const mods = (m?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("abstract");
  });

  it("auto-accessor field includes accessor in modifiers (not only accessor_kind)", () => {
    const syms = ext(`class C { accessor title = ""; }`);
    const f = syms.find((s) => s.name === "title");
    expect(f?.meta?.["accessor_kind"]).toBe("accessor");
    const mods = (f?.meta?.["modifiers"] as string[] | undefined) ?? [];
    expect(mods).toContain("accessor");
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

describe("L11 anonymous default export", () => {
  it("synthesizes name=default for `export default function() {}`", () => {
    const syms = ext(`export default function() { return 1; }`);
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("default_export");
    expect(def?.is_exported).toBe(true);
  });

  it("synthesizes name=default for `export default class {}`", () => {
    const syms = ext(`export default class { method() {} }`);
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("default_export");
  });

  it("walks nested members under anonymous default class (parent chain)", () => {
    const syms = ext(`export default class { method() {} }`);
    const def = syms.find((s) => s.name === "default" && s.kind === "default_export");
    const anonCls = syms.find((s) => s.name === "<anonymous>" && s.kind === "class");
    const method = syms.find((s) => s.name === "method" && s.kind === "method");
    expect(def).toBeDefined();
    expect(method).toBeDefined();
    expect(anonCls?.parent).toBe(def?.id);
    expect(method?.parent).toBe(anonCls?.id);
  });

  it("walks body under anonymous default function", () => {
    const syms = ext(`export default function() { function inner() { return 1; } }`);
    const def = syms.find((s) => s.name === "default");
    const inner = syms.find((s) => s.name === "inner");
    expect(def?.kind).toBe("default_export");
    expect(inner?.parent).toBe(def?.id);
  });

  it("anonymous default: parenthesized function_expression", () => {
    const syms = ext(`export default (function() { return 2; })`);
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("default_export");
  });

  it("anonymous default: async function", () => {
    const syms = ext(`export default async function() { return 1; }`);
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("default_export");
  });

  it(".tsx: anonymous JSX default flagged as is_react_component", () => {
    const syms = ext(`export default function() { return <div/>; }`, "tsx");
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("default_export");
    expect(def?.meta?.["is_react_component"]).toBe(true);
  });

  it("named default export still uses its real name (not synthesized)", () => {
    const syms = ext(`export default function MyFunc() {}`);
    const fn = syms.find((s) => s.name === "MyFunc");
    expect(fn).toBeDefined();
    expect(fn?.is_exported).toBe(true);
    expect(syms.find((s) => s.name === "default")).toBeUndefined();
  });
});

describe("L2 namespace + L12 ambient declaration", () => {
  it("emits namespace M { class C } as namespace + parented class", () => {
    const syms = ext(`namespace M { export class C {} }`);
    const ns = syms.find((s) => s.name === "M" && s.kind === "namespace");
    const cls = syms.find((s) => s.name === "C" && s.kind === "class");
    expect(ns).toBeDefined();
    expect(cls?.parent).toBe(ns?.id);
  });

  it("emits exported namespace as is_exported", () => {
    const syms = ext(`export namespace N { const x = 1; }`);
    const ns = syms.find((s) => s.name === "N");
    expect(ns?.is_exported).toBe(true);
  });

  it("emits `declare module \"x\" { fn }` as namespace x with bar exported (L12)", () => {
    const syms = ext(`declare module "x" { export function bar(): void; }`);
    const ns = syms.find((s) => s.name === "x" && s.kind === "namespace");
    expect(ns?.is_exported).toBe(true);
    const bar = syms.find((s) => s.name === "bar");
    expect(bar?.parent).toBe(ns?.id);
    expect(bar?.is_exported).toBe(true);
  });

  it("indexes declare module with empty string specifier", () => {
    const syms = ext(`declare module "" { export const z: number; }`);
    const ns = syms.find((s) => s.name === "" && s.kind === "namespace");
    expect(ns).toBeDefined();
    expect(ns?.is_exported).toBe(true);
    expect(syms.find((s) => s.name === "z")?.parent).toBe(ns?.id);
  });

  it("tags ambient overload signatures with overload_index on second+ declaration", () => {
    const syms = ext(`declare function dupe(): void; declare function dupe(a: number): void;`);
    const fsigs = syms.filter((s) => s.name === "dupe");
    expect(fsigs.length).toBe(2);
    const meta0 = fsigs[0]?.meta as Record<string, unknown> | undefined;
    const meta1 = fsigs[1]?.meta as Record<string, unknown> | undefined;
    expect(meta0?.["overload_index"]).toBeUndefined();
    expect(meta1?.["overload_index"]).toBe(1);
  });

  it("emits `declare const X` as exported (declare ambient + export)", () => {
    const syms = ext(`export declare const X: number;`);
    const x = syms.find((s) => s.name === "X");
    expect(x?.is_exported).toBe(true);
  });

  it("does NOT mark plain `declare const X` (no export) as exported", () => {
    const syms = ext(`declare const X: number;`);
    const x = syms.find((s) => s.name === "X");
    expect(x?.is_exported).toBeUndefined();
  });

  it(".tsx parity: namespace extraction in TSX", () => {
    const syms = ext(`namespace N { export const x = 1; }`, "tsx");
    const ns = syms.find((s) => s.name === "N" && s.kind === "namespace");
    expect(ns).toBeDefined();
  });
});

describe("Edge cases — RangeError + grammar errors", () => {
  it("logs a warning when source contains grammar errors but does not throw", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Source with a deliberate parse error — unmatched braces.
    const broken = `class Foo { method() { @@@ broken `;
    expect(() => ext(broken)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/grammar errors detected/));
    warnSpy.mockRestore();
  });

  it("normal source produces no grammar-error warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ext(`class Foo { method() {} }`);
    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => /grammar errors detected/.test(c))).toBe(false);
    warnSpy.mockRestore();
  });
});
