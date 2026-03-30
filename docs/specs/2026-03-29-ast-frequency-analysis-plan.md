# Implementation Plan: AST Frequency Analysis

**Spec:** docs/specs/2026-03-29-ast-frequency-analysis-spec.md
**Created:** 2026-03-29
**Tasks:** 5
**Estimated complexity:** 4 standard, 1 complex

## Architecture Summary

Single new module `src/tools/frequency-tools.ts` following the established analysis-tool pattern (like `clone-tools.ts`). Dependencies: `getCodeIndex` (index-tools), `parseFile` (parser-manager), types (types.ts). Registration via `TOOL_DEFINITIONS` array in `register-tools.ts`. Zero new npm dependencies.

Data flow: `getCodeIndex(repo)` → filter symbols → re-parse each `symbol.source` via `parseFile` → post-order AST walk → normalize nodes (identifiers→`_`, strings→`_S`, numbers→`_N`, booleans→`_B`) → Merkle hash bottom-up → `Map<hash, symbols[]>` → filter min_nodes → sort by count desc → top_n → serialize with token_budget.

## Technical Decisions

- **Normalization:** tree-sitter re-parse (not regex) — precise node type awareness
- **Hash:** djb2 Merkle bottom-up: `hash(node) = djb2(node.type + childHashes)`
- **Walker:** iterative post-order (explicit stack) to avoid stack overflow on deep ASTs
- **Clustering:** exact hash match only (O(n)), no fuzzy
- **Symbol filter:** inline loop (clone-tools prepareEntries pattern), local `ANALYZABLE_KINDS`
- **Token budget:** greedy pack after sort (search-tools.ts pattern)
- **Kind param:** comma-separated string, parsed inline with `split(",").map(s => s.trim())`

## Quality Strategy

- **Test framework:** Vitest (core project, vmForks)
- **Mock boundaries:** `getCodeIndex` (vi.mock index-tools.js) + `parseFile` (vi.mock parser-manager.js)
- **Fixture pattern:** inline `makeSymbol()` + `makeIndex()` + `makeFakeTree()` factories
- **Active CQ gates:** CQ3 (repo validation), CQ6 (bounded output), CQ8 (parseFile null), CQ14 (djb2 duplication acceptable)
- **Risks:** parseFile mock fidelity (HIGH), walker stack overflow (HIGH — mitigated by iterative), node type variance by language (MEDIUM)

## Task Breakdown

### Task 1: Types, djb2 hash, and AST node normalization
**Files:** `src/tools/frequency-tools.ts`, `tests/tools/frequency-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/frequency-tools.test.ts
  import { describe, it, expect } from "vitest";
  import { djb2, normalizeNodeType } from "../../src/tools/frequency-tools.js";

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
  ```

- [ ] GREEN: Implement minimum code to pass
  ```typescript
  // src/tools/frequency-tools.ts
  import type { SymbolKind, CodeSymbol } from "../types.js";

  // --- Exported types ---

  export interface ShapeCluster {
    hash: string;
    root_node_type: string;
    count: number;
    node_count: number;
    shape_preview: string;
    examples: Array<{
      name: string;
      kind: SymbolKind;
      file: string;
      start_line: number;
    }>;
  }

  export interface FrequencyResult {
    clusters: ShapeCluster[];
    summary: {
      total_symbols_analyzed: number;
      total_nodes_hashed: number;
      total_clusters_found: number;
      clusters_returned: number;
      skipped_no_source: number;
      skipped_truncated: number;
      skipped_below_min: number;
      low_signal: boolean;
    };
  }

  // --- Hash ---

  export function djb2(s: string): number {
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
  }

  // --- Normalization ---

  const IDENTIFIER_TYPES = new Set(["identifier", "property_identifier", "type_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "name"]);
  const STRING_TYPES = new Set(["string", "template_string", "string_fragment", "string_content"]);
  const NUMBER_TYPES = new Set(["number", "integer", "float"]);
  const BOOLEAN_TYPES = new Set(["true", "false"]);

  export function normalizeNodeType(nodeType: string, _text: string): string {
    if (IDENTIFIER_TYPES.has(nodeType)) return "_";
    if (STRING_TYPES.has(nodeType)) return "_S";
    if (NUMBER_TYPES.has(nodeType)) return "_N";
    if (BOOLEAN_TYPES.has(nodeType)) return "_B";
    return nodeType;
  }
  ```

- [ ] Verify: `npx vitest run tests/tools/frequency-tools.test.ts`
  Expected: all tests pass (12 tests)
- [ ] Commit: `feat(frequency): add djb2 hash and AST node normalization primitives`

---

### Task 2: Iterative post-order Merkle hash walker
**Files:** `src/tools/frequency-tools.ts`, `tests/tools/frequency-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/frequency-tools.test.ts — append to existing file
  import { hashSubtree } from "../../src/tools/frequency-tools.js";

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
      // Build a 200-level deep tree
      let node: FakeNode = makeLeaf("identifier", "x");
      for (let i = 0; i < 200; i++) {
        node = makeNode("expression_statement", "", [node]);
      }
      expect(() => hashSubtree(node as any)).not.toThrow();
    });
  });
  ```

- [ ] GREEN: Implement minimum code to pass
  ```typescript
  // src/tools/frequency-tools.ts — add to existing file

  interface HashResult {
    hash: number;
    nodeCount: number;
    normalizedPreview: string;
  }

  export function hashSubtree(root: any): HashResult {
    // Iterative post-order traversal using explicit stack
    const stack: Array<{ node: any; childIndex: number }> = [{ node: root, childIndex: 0 }];
    const hashMap = new Map<any, { hash: number; count: number; preview: string }>();
    const previewParts: string[] = [];

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const children = top.node.namedChildren || [];

      if (top.childIndex < children.length) {
        // Push next child
        const child = children[top.childIndex];
        top.childIndex++;
        stack.push({ node: child, childIndex: 0 });
      } else {
        // All children processed — compute this node's hash
        stack.pop();
        const node = top.node;
        const normalized = normalizeNodeType(node.type, node.text || "");

        let hashStr = normalized;
        let count = 1;
        for (const child of children) {
          const childResult = hashMap.get(child);
          if (childResult) {
            hashStr += ":" + childResult.hash.toString(36);
            count += childResult.count;
          }
        }

        const h = djb2(hashStr);
        hashMap.set(node, { hash: h, count, preview: normalized });
      }
    }

    const rootResult = hashMap.get(root);
    if (!rootResult) return { hash: 0, nodeCount: 0, normalizedPreview: "" };

    // Build normalized preview from root walk (simplified)
    const buildPreview = (node: any, depth: number): string => {
      if (depth > 10) return "...";
      const norm = normalizeNodeType(node.type, node.text || "");
      const children = (node.namedChildren || [])
        .map((c: any) => buildPreview(c, depth + 1))
        .join(" ");
      return children ? `${norm}(${children})` : norm;
    };

    return {
      hash: rootResult.hash,
      nodeCount: rootResult.count,
      normalizedPreview: buildPreview(root, 0).slice(0, 300),
    };
  }
  ```

- [ ] Verify: `npx vitest run tests/tools/frequency-tools.test.ts`
  Expected: all tests pass (18+ tests)
- [ ] Commit: `feat(frequency): add iterative Merkle hash walker for AST subtrees`

---

### Task 3: Core frequencyAnalysis function — filtering, parsing, clustering
**Files:** `src/tools/frequency-tools.ts`, `tests/tools/frequency-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1, Task 2
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/frequency-tools.test.ts — append

  import { frequencyAnalysis } from "../../src/tools/frequency-tools.js";

  const mockGetCodeIndex = vi.fn();
  const mockParseFile = vi.fn();

  vi.mock("../../src/tools/index-tools.js", () => ({
    getCodeIndex: (...args: any[]) => mockGetCodeIndex(...args),
  }));

  vi.mock("../../src/parser/parser-manager.js", () => ({
    parseFile: (...args: any[]) => mockParseFile(...args),
  }));

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

  // Reuse makeNode/makeLeaf from Task 2

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
      const symbols = Array.from({ length: 100 }, (_, i) => {
        const tree = makeNode("function_declaration", "", [
          makeLeaf("number", String(i)), // different literal → different hash after normalization... wait, number normalizes to _N
        ]);
        return makeSymbol({ name: `fn${i}`, source: `function fn${i}() { return ${i}; }` });
      });

      // Each has same tree shape since numbers normalize to _N → 1 giant cluster
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
  ```

- [ ] GREEN: Implement minimum code to pass
  ```typescript
  // src/tools/frequency-tools.ts — add to existing file

  import { getCodeIndex } from "./index-tools.js";
  import { parseFile } from "../parser/parser-manager.js";
  import { isTestFileStrict as isTestFile } from "../utils/test-file.js";

  const ANALYZABLE_KINDS = new Set<SymbolKind>(["function", "method", "class"]);

  interface FrequencyOptions {
    top_n?: number;
    min_nodes?: number;
    file_pattern?: string;
    kind?: string;
    include_tests?: boolean;
    token_budget?: number;
  }

  export async function frequencyAnalysis(
    repo: string,
    options?: FrequencyOptions,
  ): Promise<FrequencyResult> {
    const index = await getCodeIndex(repo);
    if (!index) throw new Error(`Repository "${repo}" not found. Run index_folder first.`);

    const topN = options?.top_n ?? 30;
    const minNodes = options?.min_nodes ?? 5;
    const includeTests = options?.include_tests ?? false;
    const kinds = options?.kind
      ? new Set(options.kind.split(",").map(s => s.trim()))
      : ANALYZABLE_KINDS;

    let skippedNoSource = 0;
    let skippedTruncated = 0;
    let skippedBelowMin = 0;
    let totalNodesHashed = 0;

    const clusterMap = new Map<number, {
      rootNodeType: string;
      nodeCount: number;
      normalizedPreview: string;
      symbols: Array<{ name: string; kind: SymbolKind; file: string; start_line: number }>;
    }>();

    const filteredSymbols: CodeSymbol[] = [];
    for (const sym of index.symbols) {
      if (!kinds.has(sym.kind)) continue;
      if (!includeTests && isTestFile(sym.file)) continue;
      if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;
      if (!sym.source) { skippedNoSource++; continue; }
      if (sym.source.endsWith("...")) { skippedTruncated++; continue; }
      filteredSymbols.push(sym);
    }

    for (const sym of filteredSymbols) {
      const tree = await parseFile(sym.file, sym.source!);
      if (!tree) { skippedNoSource++; continue; }

      const result = hashSubtree(tree.rootNode);
      totalNodesHashed += result.nodeCount;

      if (result.nodeCount < minNodes) { skippedBelowMin++; continue; }

      const existing = clusterMap.get(result.hash);
      if (existing) {
        existing.symbols.push({
          name: sym.name,
          kind: sym.kind,
          file: sym.file,
          start_line: sym.start_line,
        });
      } else {
        clusterMap.set(result.hash, {
          rootNodeType: tree.rootNode.type,
          nodeCount: result.nodeCount,
          normalizedPreview: result.normalizedPreview,
          symbols: [{
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            start_line: sym.start_line,
          }],
        });
      }
    }

    // Filter single-occurrence clusters, sort by count desc
    const allClusters = [...clusterMap.entries()]
      .filter(([_, c]) => c.symbols.length >= 2)
      .sort((a, b) => b[1].symbols.length - a[1].symbols.length);

    const totalClustersFound = allClusters.length;
    const topClusters = allClusters.slice(0, topN);

    const clusters: ShapeCluster[] = topClusters.map(([hash, c]) => ({
      hash: (hash >>> 0).toString(16).padStart(8, "0"),
      root_node_type: c.rootNodeType,
      count: c.symbols.length,
      node_count: c.nodeCount,
      shape_preview: c.normalizedPreview.slice(0, 300),
      examples: c.symbols
        .sort((a, b) => a.file.localeCompare(b.file))
        .slice(0, 5),
    }));

    const largestCount = clusters[0]?.count ?? 0;

    return {
      clusters,
      summary: {
        total_symbols_analyzed: filteredSymbols.length,
        total_nodes_hashed: totalNodesHashed,
        total_clusters_found: totalClustersFound,
        clusters_returned: clusters.length,
        skipped_no_source: skippedNoSource,
        skipped_truncated: skippedTruncated,
        skipped_below_min: skippedBelowMin,
        low_signal: filteredSymbols.length < 50 || largestCount < 3,
      },
    };
  }
  ```

- [ ] Verify: `npx vitest run tests/tools/frequency-tools.test.ts`
  Expected: all tests pass (28+ tests)
- [ ] Commit: `feat(frequency): add core frequencyAnalysis with filtering, parsing, and clustering`

---

### Task 4: Token budget support
**Files:** `src/tools/frequency-tools.ts`, `tests/tools/frequency-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 3
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/frequency-tools.test.ts — append

  describe("token budget", () => {
    it("truncates clusters when token_budget is exceeded", async () => {
      // Create 10 clusters of varying sizes
      const symbols = [];
      for (let group = 0; group < 10; group++) {
        const tree = makeNode("function_declaration", "", [
          makeLeaf("identifier", "x"),
          // Vary structure per group to get different hashes
          ...Array.from({ length: group + 2 }, () =>
            makeNode("expression_statement", "", [makeLeaf("identifier", "y")])
          ),
        ]);
        for (let i = 0; i < (10 - group); i++) {
          symbols.push(makeSymbol({
            name: `fn_g${group}_${i}`,
            file: `src/g${group}/file${i}.ts`,
            source: `function fn() { ${"x(); ".repeat(group + 2)} }`,
          }));
        }
      }

      mockGetCodeIndex.mockResolvedValue(makeIndex(symbols));
      // Each group gets a different tree structure based on symbol name
      mockParseFile.mockImplementation(async (file: string) => {
        // Extract group number from file path (src/gN/...)
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
      // Reset mocks for second call — same mock implementation is stateless (uses file path, not counter)
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
  ```

- [ ] GREEN: Implement token budget logic
  ```typescript
  // In frequencyAnalysis, after building topClusters, before final return:
  // Add token budget trimming

  const CHARS_PER_TOKEN = 4;

  let budgetClusters = topClusters;
  if (options?.token_budget) {
    const summaryTokens = 200; // reserve for summary
    let used = summaryTokens;
    const fitted: typeof topClusters = [];
    for (const entry of topClusters) {
      const tok = Math.ceil(JSON.stringify(entry).length / CHARS_PER_TOKEN);
      if (used + tok > options.token_budget) break;
      used += tok;
      fitted.push(entry);
    }
    budgetClusters = fitted;
  }

  // Use budgetClusters instead of topClusters for final serialization
  ```

- [ ] Verify: `npx vitest run tests/tools/frequency-tools.test.ts`
  Expected: all tests pass (30+ tests)
- [ ] Commit: `feat(frequency): add token budget support for output truncation`

---

### Task 5: MCP tool registration
**Files:** `src/register-tools.ts`, `src/server-helpers.ts`, `tests/tools/frequency-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 3
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/tools/frequency-tools.test.ts — append

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
  ```

- [ ] GREEN: Register the tool
  ```typescript
  // src/register-tools.ts — add import at top
  import { frequencyAnalysis } from "./tools/frequency-tools.js";

  // Add to TOOL_DEFINITIONS array (after find_clones entry):
  {
    name: "frequency_analysis",
    description: "Find the most common code structures by normalizing AST and grouping by shape. Discovers emergent patterns invisible to regex: functions with the same control flow but different variable names are grouped together. Returns TOP N clusters with examples. For similar-but-not-identical pairs, use find_clones instead.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
      min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      kind: z.string().optional().describe("Filter by symbol kind, comma-separated (default: function,method)"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
      token_budget: zNum().optional().describe("Max tokens for response"),
    },
    handler: async (args) => frequencyAnalysis(
      args.repo as string,
      {
        top_n: args.top_n as number | undefined,
        min_nodes: args.min_nodes as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
        kind: args.kind as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        token_budget: args.token_budget as number | undefined,
      },
    ),
  },
  ```

  ```typescript
  // src/server-helpers.ts — add to SAVINGS_MULTIPLIER map
  frequency_analysis: 2.0,
  ```

- [ ] Verify: `npx vitest run tests/tools/frequency-tools.test.ts`
  Expected: all tests pass (31+ tests)
- [ ] Commit: `feat(frequency): register frequency_analysis as MCP tool`

---

### Post-implementation: Self-test (AC12)

After all tasks complete, manually verify on the real repo:

```bash
codesift frequency-analysis local/codesift-mcp --top-n 10
```

Expected: clusters appear for known patterns (e.g., similar extractors in `src/parser/extractors/`). This is a manual acceptance check, not an automated test.
