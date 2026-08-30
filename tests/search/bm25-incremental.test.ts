import { describe, it, expect } from "vitest";
import { buildBM25Index, updateBM25ForFile, searchBM25 } from "../../src/search/bm25.js";
import type { BM25Index } from "../../src/search/bm25.js";
import type { CodeSymbol } from "../../src/types.js";

function sym(over: Partial<CodeSymbol> & { id: string; name: string; file: string }): CodeSymbol {
  return { repo: "test", kind: "function", start_line: 1, end_line: 5, ...over };
}

const WEIGHTS = { name: 3.0, signature: 2.0, docstring: 1.5, body: 1.0, comments: 0.5 };

const fileA: CodeSymbol[] = [
  sym({ id: "a1", name: "getUserById", file: "a.ts", signature: "getUserById(id: string): User" }),
  sym({ id: "a2", name: "createUser", file: "a.ts", source: "function createUser() { return db.insert(); }" }),
];
const fileBOld: CodeSymbol[] = [
  sym({ id: "b1", name: "legacyQuarkHandler", file: "b.ts", signature: "legacyQuarkHandler(): void" }),
];
const fileBNew: CodeSymbol[] = [
  sym({ id: "b2", name: "modernPulsarHandler", file: "b.ts", signature: "modernPulsarHandler(): Promise<void>" }),
  sym({ id: "b3", name: "pulsarRetry", file: "b.ts", source: "// retries the pulsar\nfunction pulsarRetry() {}" }),
];

/**
 * Everything a search reads, EXCEPT `centrality` — updateBM25ForFile deliberately leaves that
 * alone (it is an O(imports x files) scan and a ranking bonus, not a correctness input), so
 * asserting on it here would be asserting the opposite of the documented behaviour.
 */
function comparable(index: BM25Index) {
  const fields: Record<string, Record<string, Record<string, number>>> = {};
  for (const [field, postings] of Object.entries(index.fields)) {
    const byToken: Record<string, Record<string, number>> = {};
    for (const [token, forToken] of postings) byToken[token] = Object.fromEntries(forToken);
    fields[field] = byToken;
  }
  return {
    fields,
    docCount: index.docCount,
    avgFieldLengths: index.avgFieldLengths,
    totalFieldLengths: index.totalFieldLengths,
    symbolIds: [...index.symbols.keys()].sort(),
    fieldLengths: Object.fromEntries([...index.fieldLengths].sort(([x], [y]) => x.localeCompare(y))),
  };
}

describe("updateBM25ForFile", () => {
  it("produces the same index as a full rebuild when a file's symbols change", () => {
    const incremental = buildBM25Index([...fileA, ...fileBOld]);
    updateBM25ForFile(incremental, "b.ts", fileBNew);

    const rebuilt = buildBM25Index([...fileA, ...fileBNew]);
    expect(comparable(incremental)).toEqual(comparable(rebuilt));
  });

  it("produces the same index as a full rebuild when a file is deleted", () => {
    const incremental = buildBM25Index([...fileA, ...fileBOld]);
    updateBM25ForFile(incremental, "b.ts", []);

    expect(comparable(incremental)).toEqual(comparable(buildBM25Index(fileA)));
  });

  it("stops returning symbols that the edit removed", () => {
    const index = buildBM25Index([...fileA, ...fileBOld]);
    expect(searchBM25(index, "legacyQuarkHandler", 10, WEIGHTS).length).toBeGreaterThan(0);

    updateBM25ForFile(index, "b.ts", fileBNew);

    // Not "returns nothing": the tokenizer splits identifiers, and `handler` still exists in the
    // replacement. What must be gone is the deleted SYMBOL, which is the actual claim.
    const after = searchBM25(index, "legacyQuarkHandler", 10, WEIGHTS);
    expect(after.map((r) => r.symbol.id)).not.toContain("b1");
    expect(searchBM25(index, "modernPulsarHandler", 10, WEIGHTS)[0]?.symbol.id).toBe("b2");
    // The untouched file must survive the swap — this is the whole point of not dropping the index.
    expect(searchBM25(index, "getUserById", 10, WEIGHTS)[0]?.symbol.id).toBe("a1");
  });

  it("does not leak vocabulary — a token nobody carries any more is dropped", () => {
    const index = buildBM25Index([...fileA, ...fileBOld]);
    expect(index.fields.name.has("legacy")).toBe(true);

    updateBM25ForFile(index, "b.ts", fileBNew);

    // Left behind, an orphaned token keeps inflating every idf denominator for the life of the
    // daemon, so search quality would decay the longer a process ran.
    expect(index.fields.name.has("legacy")).toBe(false);
    expect(index.fields.name.has("quark")).toBe(false);
  });

  it("leaves other files alone when an incoming id collides with a symbol elsewhere", () => {
    // Symbol ids are `repo:file:name:line` and are documented as NOT unique. Selecting rows to
    // remove by the incoming ids would delete a same-id symbol living in a different file.
    const shared = "dup-id";
    const index = buildBM25Index([
      sym({ id: shared, name: "aardvarkHelper", file: "a.ts" }),
      sym({ id: "b1", name: "legacyQuarkHandler", file: "b.ts" }),
    ]);

    updateBM25ForFile(index, "b.ts", [sym({ id: shared, name: "badgerHelper", file: "b.ts" })]);

    expect(index.symbols.has(shared)).toBe(true);
    expect(searchBM25(index, "legacyQuarkHandler", 10, WEIGHTS)).toEqual([]);
  });

  it("is repeatable — applying the same edit twice does not double-count", () => {
    const index = buildBM25Index([...fileA, ...fileBOld]);
    updateBM25ForFile(index, "b.ts", fileBNew);
    updateBM25ForFile(index, "b.ts", fileBNew);

    expect(comparable(index)).toEqual(comparable(buildBM25Index([...fileA, ...fileBNew])));
  });
});
