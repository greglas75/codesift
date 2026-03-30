import { describe, it, expect, vi, beforeEach } from "vitest";
import { djb2, normalizeNodeType, hashSubtree, frequencyAnalysis } from "../../src/tools/frequency-tools.js";

const mockGetCodeIndex = vi.fn();
const mockParseFile = vi.fn();

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: (...args: any[]) => mockGetCodeIndex(...args),
}));

vi.mock("../../src/parser/parser-manager.js", () => ({
  parseFile: (...args: any[]) => mockParseFile(...args),
}));

// Minimal tree-sitter node stub
interface FakeNode {
  type: string;
  text: string;
  namedChildCount: number;
  namedChildren: FakeNode[];
  childCount: number;
  children: FakeNode[];
  isNamed: boolean;
}

function makeNode(type: string, text: string, children: FakeNode[] = []): FakeNode {
  return {
    type,
    text,
    namedChildCount: children.filter(c => c.isNamed).length,
    namedChildren: children.filter(c => c.isNamed),
    childCount: children.length,
    children,
    isNamed: true,
  };
}

function makeLeaf(type: string, text: string): FakeNode {
  return makeNode(type, text, []);
}

describe("djb2", () => {
  it("produces consistent hash for same input", () => {
    expect(djb2("function_declaration")).toBe(djb2("function_declaration"));
  });

  it("produces different hashes for different inputs", () => {
    expect(djb2("function_declaration")).not.toBe(djb2("if_statement"));
  });

  it("returns unsigned 32-bit number", () => {
    const h = djb2("test");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
  });
});

describe("normalizeNodeType", () => {
  it("replaces identifier with _", () => {
    expect(normalizeNodeType("identifier", "myVar")).toBe("_");
  });

  it("replaces property_identifier with _", () => {
    expect(normalizeNodeType("property_identifier", "name")).toBe("_");
  });

  it("replaces type_identifier with _", () => {
    expect(normalizeNodeType("type_identifier", "MyType")).toBe("_");
  });

  it("replaces string with _S", () => {
    expect(normalizeNodeType("string", '"hello"')).toBe("_S");
  });

  it("replaces template_string with _S", () => {
    expect(normalizeNodeType("template_string", "`hello`")).toBe("_S");
  });

  it("replaces number with _N", () => {
    expect(normalizeNodeType("number", "42")).toBe("_N");
  });

  it("replaces true/false with _B", () => {
    expect(normalizeNodeType("true", "true")).toBe("_B");
    expect(normalizeNodeType("false", "false")).toBe("_B");
  });

  it("keeps keywords as node type", () => {
    expect(normalizeNodeType("return_statement", "")).toBe("return_statement");
  });

  it("keeps operators as node type", () => {
    expect(normalizeNodeType("binary_expression", "")).toBe("binary_expression");
  });
});

describe("hashSubtree", () => {
  it("returns hash and node count for a leaf", () => {
    const node = makeLeaf("identifier", "foo");
    const result = hashSubtree(node as any);
    expect(result.hash).toBeGreaterThanOrEqual(0);
    expect(result.nodeCount).toBe(1);
  });

  it("produces same hash for identifiers with different names", () => {
    const a = hashSubtree(makeLeaf("identifier", "foo") as any);
    const b = hashSubtree(makeLeaf("identifier", "bar") as any);
    expect(a.hash).toBe(b.hash);
  });

  it("produces different hashes for different node types", () => {
    const a = hashSubtree(makeLeaf("identifier", "x") as any);
    const b = hashSubtree(makeLeaf("number", "42") as any);
    expect(a.hash).not.toBe(b.hash);
  });

  it("counts all nodes in subtree", () => {
    const tree = makeNode("function_declaration", "", [
      makeLeaf("identifier", "foo"),
      makeNode("formal_parameters", "()", []),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [
          makeLeaf("identifier", "x"),
        ]),
      ]),
    ]);
    const result = hashSubtree(tree as any);
    expect(result.nodeCount).toBe(6); // root + id + params + block + return_stmt + x
  });

  it("produces same hash for structurally identical trees with different identifiers", () => {
    const treeA = makeNode("function_declaration", "", [
      makeLeaf("identifier", "getUserById"),
      makeNode("formal_parameters", "()", [makeLeaf("identifier", "id")]),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [makeLeaf("identifier", "user")]),
      ]),
    ]);
    const treeB = makeNode("function_declaration", "", [
      makeLeaf("identifier", "getOrderById"),
      makeNode("formal_parameters", "()", [makeLeaf("identifier", "orderId")]),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [makeLeaf("identifier", "order")]),
      ]),
    ]);
    expect(hashSubtree(treeA as any).hash).toBe(hashSubtree(treeB as any).hash);
  });

  it("handles deep trees without stack overflow", () => {
    let node: FakeNode = makeLeaf("identifier", "x");
    for (let i = 0; i < 200; i++) {
      node = makeNode("expression_statement", "", [node]);
    }
    expect(() => hashSubtree(node as any)).not.toThrow();
  });
});

// --- frequencyAnalysis helpers ---

function makeSymbol(overrides: Partial<any> = {}) {
  return {
    id: "test:file.ts:fn:1",
    repo: "test",
    name: overrides.name ?? "testFn",
    kind: overrides.kind ?? "function",
    file: overrides.file ?? "src/test.ts",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 10,
    source: overrides.source ?? "function test() { return 1; }",
    ...overrides,
  };
}

function makeIndex(symbols: any[]) {
  return {
    repo: "local/test",
    root: "/test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 1,
  };
}

describe("frequencyAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when repo not found", async () => {
    mockGetCodeIndex.mockResolvedValue(null);
    await expect(frequencyAnalysis("unknown")).rejects.toThrow();
  });

  it("returns empty clusters for empty index", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([]));
    const result = await frequencyAnalysis("test");
    expect(result.clusters).toEqual([]);
    expect(result.summary.total_symbols_analyzed).toBe(0);
  });

  it("groups symbols with identical AST shape", async () => {
    const identicalTree = makeNode("function_declaration", "", [
      makeLeaf("identifier", "x"),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [makeLeaf("identifier", "y")]),
      ]),
    ]);

    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "fnA", source: "function fnA() { return a; }" }),
      makeSymbol({ name: "fnB", source: "function fnB() { return b; }" }),
      makeSymbol({ name: "fnC", source: "function fnC() { return c; }" }),
    ]));
    mockParseFile.mockResolvedValue({ rootNode: identicalTree });

    const result = await frequencyAnalysis("test");
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.count).toBe(3);
    expect(result.clusters[0]!.examples.length).toBe(3);
  });

  it("excludes symbols without source", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "noSrc", source: undefined }),
      makeSymbol({ name: "hasSrc", source: "function x() {}" }),
    ]));
    mockParseFile.mockResolvedValue({ rootNode: makeLeaf("function_declaration", "") });

    const result = await frequencyAnalysis("test", { min_nodes: 1 });
    expect(result.summary.skipped_no_source).toBe(1);
  });

  it("excludes symbols with truncated source", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "truncated", source: "function big() { /* lots of code */ }..." }),
    ]));

    const result = await frequencyAnalysis("test");
    expect(result.summary.skipped_truncated).toBe(1);
  });

  it("skips symbols where parseFile returns null", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "binary", source: "binary content" }),
    ]));
    mockParseFile.mockResolvedValue(null);

    const result = await frequencyAnalysis("test");
    expect(result.summary.skipped_no_source).toBeGreaterThanOrEqual(1);
  });

  it("filters by kind parameter", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "fn", kind: "function", source: "function x() {}" }),
      makeSymbol({ name: "cls", kind: "class", source: "class X {}" }),
    ]));
    mockParseFile.mockResolvedValue({ rootNode: makeLeaf("function_declaration", "") });

    const result = await frequencyAnalysis("test", { kind: "function", min_nodes: 1 });
    expect(result.summary.total_symbols_analyzed).toBe(1);
  });

  it("excludes test files by default", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "prod", file: "src/service.ts", source: "function x() {}" }),
      makeSymbol({ name: "test", file: "src/service.test.ts", source: "function x() {}" }),
    ]));
    mockParseFile.mockResolvedValue({ rootNode: makeLeaf("function_declaration", "") });

    const result = await frequencyAnalysis("test", { min_nodes: 1 });
    expect(result.summary.total_symbols_analyzed).toBe(1);
  });

  it("sets low_signal when fewer than 50 symbols", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "fn1", source: "function x() {}" }),
    ]));
    mockParseFile.mockResolvedValue({ rootNode: makeLeaf("function_declaration", "") });

    const result = await frequencyAnalysis("test", { min_nodes: 1 });
    expect(result.summary.low_signal).toBe(true);
  });

  it("respects top_n limit", async () => {
    const symbols = Array.from({ length: 100 }, (_, i) =>
      makeSymbol({ name: `fn${i}`, source: `function fn${i}() { return ${i}; }` })
    );
    mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));
    const tree = makeNode("function_declaration", "", [
      makeLeaf("identifier", "x"),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [makeLeaf("number", "0")]),
      ]),
    ]);
    mockParseFile.mockResolvedValue({ rootNode: tree });

    const result = await frequencyAnalysis("test", { top_n: 5 });
    expect(result.clusters.length).toBeLessThanOrEqual(5);
  });
});

describe("token budget", () => {
  it("truncates clusters when token_budget is exceeded", async () => {
    const symbols = [];
    for (let group = 0; group < 10; group++) {
      for (let i = 0; i < (10 - group); i++) {
        symbols.push(makeSymbol({
          name: `fn_g${group}_${i}`,
          file: `src/g${group}/file${i}.ts`,
          source: `function fn() { ${"x(); ".repeat(group + 2)} }`,
        }));
      }
    }

    mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));
    mockParseFile.mockImplementation(async (file: string) => {
      const match = file.match(/g(\d+)/);
      const group = match ? parseInt(match[1], 10) : 0;
      const tree = makeNode("function_declaration", "", [
        makeLeaf("identifier", "x"),
        ...Array.from({ length: group + 2 }, () =>
          makeNode("expression_statement", "", [makeLeaf("identifier", "y")])
        ),
      ]);
      return { rootNode: tree };
    });

    const resultFull = await frequencyAnalysis("test", { min_nodes: 1 });
    mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));
    const resultBudget = await frequencyAnalysis("test", { min_nodes: 1, token_budget: 500 });

    expect(resultBudget.clusters.length).toBeLessThan(resultFull.clusters.length);
    expect(resultBudget.summary.clusters_returned).toBeLessThan(resultBudget.summary.total_clusters_found);
  });

  it("returns all clusters when budget is sufficient", async () => {
    mockGetCodeIndex.mockResolvedValue(makeIndex([
      makeSymbol({ name: "a", source: "function a() { return 1; }" }),
      makeSymbol({ name: "b", source: "function b() { return 2; }" }),
    ]));
    const tree = makeNode("function_declaration", "", [
      makeLeaf("identifier", "x"),
      makeNode("statement_block", "{}", [
        makeNode("return_statement", "return", [makeLeaf("number", "0")]),
      ]),
    ]);
    mockParseFile.mockResolvedValue({ rootNode: tree });

    const result = await frequencyAnalysis("test", { min_nodes: 1, token_budget: 50000 });
    expect(result.summary.clusters_returned).toBe(result.summary.total_clusters_found);
  });
});

describe("registration", () => {
  it("frequency_analysis tool is registered on the server", async () => {
    const { registerTools } = await import("../../src/register-tools.js");
    const toolNames: string[] = [];
    const mockServer = {
      tool: (name: string, ..._args: any[]) => { toolNames.push(name); },
    };
    registerTools(mockServer as any);
    expect(toolNames).toContain("frequency_analysis");
  });
});
