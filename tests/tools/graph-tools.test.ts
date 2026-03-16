import { describe, it, expect } from "vitest";
import {
  extractCallSites,
  buildAdjacencyIndex,
  buildCallTree,
} from "../../src/tools/graph-tools.js";
import type { CodeSymbol, Direction } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal CodeSymbol fixture */
function sym(
  overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "id" | "name" | "file">,
): CodeSymbol {
  return {
    repo: "test",
    kind: "function",
    start_line: 1,
    end_line: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractCallSites
// ---------------------------------------------------------------------------

describe("extractCallSites", () => {
  it("should extract simple function calls", () => {
    const calls = extractCallSites("const x = foo(); bar(1, 2);");
    expect(calls).toContain("foo");
    expect(calls).toContain("bar");
  });

  it("should extract method calls", () => {
    const calls = extractCallSites("this.doWork(); obj.process(data);");
    expect(calls).toContain("doWork");
    expect(calls).toContain("process");
  });

  it("should extract generic function calls", () => {
    const calls = extractCallSites("createMap<string, number>(entries);");
    expect(calls).toContain("createMap");
  });

  it("should skip JS/TS keywords that look like calls", () => {
    const calls = extractCallSites(
      "if (x) { for (const i of arr) { while (true) { switch (v) {} } } }",
    );
    expect(calls).not.toContain("if");
    expect(calls).not.toContain("for");
    expect(calls).not.toContain("while");
    expect(calls).not.toContain("switch");
  });

  it("should skip identifiers shorter than 3 characters", () => {
    const calls = extractCallSites("fn(); ab(); abc();");
    expect(calls).not.toContain("fn");
    expect(calls).not.toContain("ab");
    expect(calls).toContain("abc");
  });

  it("should return empty set for source with no calls", () => {
    const calls = extractCallSites("const x = 42; const y = 'hello';");
    expect(calls.size).toBe(0);
  });

  it("should deduplicate repeated calls to the same function", () => {
    const calls = extractCallSites("foo(); foo(); foo();");
    expect(calls.size).toBe(1);
    expect(calls).toContain("foo");
  });

  it("should handle await and new expressions", () => {
    const calls = extractCallSites(
      "const r = await fetchData(); const c = new MyClass();",
    );
    expect(calls).toContain("fetchData");
    // "new" is a keyword and filtered; MyClass is the call
    expect(calls).toContain("MyClass");
  });
});

// ---------------------------------------------------------------------------
// buildAdjacencyIndex
// ---------------------------------------------------------------------------

describe("buildAdjacencyIndex", () => {
  const fnA = sym({
    id: "test:a.ts:fnA:1",
    name: "fnA",
    file: "src/a.ts",
    source: "function fnA() { fnB(); }",
  });

  const fnB = sym({
    id: "test:b.ts:fnB:1",
    name: "fnB",
    file: "src/b.ts",
    source: "function fnB() { fnC(); }",
  });

  const fnC = sym({
    id: "test:c.ts:fnC:1",
    name: "fnC",
    file: "src/c.ts",
    source: "function fnC() { return 42; }",
  });

  it("should build callee edges from source call sites", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);

    const aCallees = adj.callees.get(fnA.id);
    expect(aCallees).toBeDefined();
    expect(aCallees!.map((s) => s.name)).toEqual(["fnB"]);
  });

  it("should build caller edges (reverse of callees)", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);

    const bCallers = adj.callers.get(fnB.id);
    expect(bCallers).toBeDefined();
    expect(bCallers!.map((s) => s.name)).toEqual(["fnA"]);
  });

  it("should not create self-referencing edges", () => {
    const selfRef = sym({
      id: "test:x.ts:recursive:1",
      name: "recursive",
      file: "src/x.ts",
      source: "function recursive() { recursive(); }",
    });

    const adj = buildAdjacencyIndex([selfRef]);
    expect(adj.callees.get(selfRef.id)).toBeUndefined();
  });

  it("should skip symbols without source", () => {
    const noSource = sym({
      id: "test:d.ts:fnD:1",
      name: "fnD",
      file: "src/d.ts",
      // no source property
    });

    const adj = buildAdjacencyIndex([noSource, fnC]);
    expect(adj.callees.size).toBe(0);
  });

  it("should skip test files when skipTests is true", () => {
    const testSym = sym({
      id: "test:a.test.ts:testFn:1",
      name: "testFn",
      file: "src/a.test.ts",
      source: "function testFn() { fnA(); }",
    });

    const adj = buildAdjacencyIndex([testSym, fnA], true);
    // testSym should be filtered out — no callers from test files
    const aCallers = adj.callers.get(fnA.id);
    expect(aCallers).toBeUndefined();
  });

  it("should include test files when skipTests is false", () => {
    const testSym = sym({
      id: "test:a.test.ts:testHelper:1",
      name: "testHelper",
      file: "src/a.test.ts",
      source: "function testHelper() { fnA(); }",
    });

    const adj = buildAdjacencyIndex([testSym, fnA], false);
    const aCallers = adj.callers.get(fnA.id);
    expect(aCallers).toBeDefined();
    expect(aCallers!.map((s) => s.name)).toContain("testHelper");
  });

  it("should skip non-callable symbol kinds", () => {
    const typeSym = sym({
      id: "test:t.ts:MyType:1",
      name: "MyType",
      file: "src/t.ts",
      kind: "type",
      source: "type MyType = string;",
    });

    const caller = sym({
      id: "test:u.ts:usesType:1",
      name: "usesType",
      file: "src/u.ts",
      source: "function usesType() { MyType(); }",
    });

    const adj = buildAdjacencyIndex([typeSym, caller]);
    // MyType is "type" kind, not callable — should not appear as callee
    const callees = adj.callees.get(caller.id);
    expect(callees).toBeUndefined();
  });

  it("should handle chain A → B → C", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);

    // A calls B
    expect(adj.callees.get(fnA.id)!.map((s) => s.name)).toEqual(["fnB"]);
    // B calls C
    expect(adj.callees.get(fnB.id)!.map((s) => s.name)).toEqual(["fnC"]);
    // C has no callers recorded for itself except B
    expect(adj.callers.get(fnC.id)!.map((s) => s.name)).toEqual(["fnB"]);
  });
});

// ---------------------------------------------------------------------------
// buildCallTree
// ---------------------------------------------------------------------------

describe("buildCallTree", () => {
  const fnA = sym({
    id: "test:a.ts:fnA:1",
    name: "fnA",
    file: "src/a.ts",
    source: "function fnA() { fnB(); }",
  });

  const fnB = sym({
    id: "test:b.ts:fnB:1",
    name: "fnB",
    file: "src/b.ts",
    source: "function fnB() { fnC(); }",
  });

  const fnC = sym({
    id: "test:c.ts:fnC:1",
    name: "fnC",
    file: "src/c.ts",
    source: "function fnC() { return 42; }",
  });

  it("should build tree of callees at depth 1", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);
    const tree = buildCallTree(fnA, adj, "callees", 1);

    expect(tree.symbol.name).toBe("fnA");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.symbol.name).toBe("fnB");
    // depth 1: fnB's children should be empty (not expanded further)
    expect(tree.children[0]!.children).toHaveLength(0);
  });

  it("should expand callees to depth 2", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);
    const tree = buildCallTree(fnA, adj, "callees", 2);

    expect(tree.symbol.name).toBe("fnA");
    expect(tree.children[0]!.symbol.name).toBe("fnB");
    expect(tree.children[0]!.children[0]!.symbol.name).toBe("fnC");
  });

  it("should build tree of callers", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);
    const tree = buildCallTree(fnC, adj, "callers", 1);

    expect(tree.symbol.name).toBe("fnC");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.symbol.name).toBe("fnB");
  });

  it("should not revisit already-visited nodes (prevents cycles)", () => {
    const cycleA = sym({
      id: "test:x.ts:cycA:1",
      name: "cycA",
      file: "src/x.ts",
      source: "function cycA() { cycB(); }",
    });
    const cycleB = sym({
      id: "test:y.ts:cycB:1",
      name: "cycB",
      file: "src/y.ts",
      source: "function cycB() { cycA(); }",
    });

    const adj = buildAdjacencyIndex([cycleA, cycleB]);
    const tree = buildCallTree(cycleA, adj, "callees", 10);

    // Should not loop infinitely — cycA → cycB, then cycA already visited
    expect(tree.symbol.name).toBe("cycA");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.symbol.name).toBe("cycB");
    // cycB tries to visit cycA again but it's visited — no children
    expect(tree.children[0]!.children).toHaveLength(0);
  });

  it("should return empty children at depth 0", () => {
    const adj = buildAdjacencyIndex([fnA, fnB, fnC]);
    const tree = buildCallTree(fnA, adj, "callees", 0);

    expect(tree.symbol.name).toBe("fnA");
    expect(tree.children).toHaveLength(0);
  });

  it("should handle node with no edges", () => {
    const isolated = sym({
      id: "test:z.ts:isolated:1",
      name: "isolated",
      file: "src/z.ts",
      source: "function isolated() { return 1; }",
    });

    const adj = buildAdjacencyIndex([isolated]);
    const tree = buildCallTree(isolated, adj, "callees", 5);

    expect(tree.symbol.name).toBe("isolated");
    expect(tree.children).toHaveLength(0);
  });
});
