import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { makeSymbol } from "../../src/parser/extractors/_shared.js";

beforeAll(async () => {
  await initParser();
});

describe("makeSymbol — is_exported field", () => {
  it("propagates is_exported: true to the produced CodeSymbol", async () => {
    const source = `function foo() {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const fnNode = tree.rootNode.firstChild!;

    const sym = makeSymbol(fnNode, "foo", "function", "a.ts", source, "test-repo", {
      is_exported: true,
    });

    expect(sym.is_exported).toBe(true);
  });

  it("propagates is_exported: false when explicitly set", async () => {
    const source = `function bar() {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const fnNode = tree.rootNode.firstChild!;

    const sym = makeSymbol(fnNode, "bar", "function", "a.ts", source, "test-repo", {
      is_exported: false,
    });

    expect(sym.is_exported).toBe(false);
  });

  it("leaves is_exported undefined when not provided (exactOptionalPropertyTypes)", async () => {
    const source = `function baz() {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const fnNode = tree.rootNode.firstChild!;

    const sym = makeSymbol(fnNode, "baz", "function", "a.ts", source, "test-repo");

    expect(sym.is_exported).toBeUndefined();
    expect("is_exported" in sym).toBe(false);
  });
});
