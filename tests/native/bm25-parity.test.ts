// ADR-006 stage 2: the native BM25 must rank exactly as the TypeScript one does — same symbols in the
// same order, same matched tokens, scores equal up to the last bit of a logarithm (Math.log and Rust's
// ln are not both correctly rounded; every other operation is IEEE-exact and done in the same order).
// A different order is a silently different search answer.
//
// Runs only when the native core is loaded; tests/native/loader.test.ts fails a run that required one.
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBM25Index,
  buildBM25IndexYielding,
  isNativeBM25,
  searchBM25,
  updateBM25ForFile,
  type BM25Index,
} from "../../src/search/bm25.js";
import { getNativeCore, resetNativeForTesting } from "../../src/native/index.js";
import type { CodeSymbol, SearchResult } from "../../src/types.js";

const native = (() => {
  try {
    return getNativeCore("bm25");
  } catch {
    return null;
  }
})();

const saved = process.env["CODESIFT_NATIVE_BM25"];
afterEach(() => {
  if (saved === undefined) delete process.env["CODESIFT_NATIVE_BM25"];
  else process.env["CODESIFT_NATIVE_BM25"] = saved;
  resetNativeForTesting();
});

const WEIGHTS = { name: 3, signature: 1.5, docstring: 1, body: 1, comments: 0.5 };

function sym(over: Partial<CodeSymbol> & { id: string; name: string; file: string }): CodeSymbol {
  return { repo: "t", kind: "function", start_line: 1, end_line: 2, ...over };
}

function corpus(): CodeSymbol[] {
  const out: CodeSymbol[] = [
    sym({ id: "u1", name: "createUser", file: "src/user.ts", signature: "(name: string): User", docstring: "Create a user record.", source: "export function createUser(name: string) {\n  // validate the user name\n  return makeUser(name); /* legacy path */\n}" }),
    sym({ id: "u2", name: "getHTTPResponseCode", file: "src/http.ts", signature: "(res: Response): number", source: "import { x } from './user';\nfunction getHTTPResponseCode(res) { return res.status; }" }),
    sym({ id: "u3", name: "createUserTest", file: "src/user.test.ts", source: "it('creates a user', () => createUser('a'))" }),
    sym({ id: "u4", name: "parse_XMLHttp_request", file: "lib/xml.py", docstring: "Parse XML over HTTP." }),
    sym({ id: "u5", name: "ΣΊΣΥΦΟΣ", file: "lib/greek.ts", source: "const ΣΊΣΥΦΟΣ = 'stone' // ανάβαση" }),
    sym({ id: "u6", name: "boundary", file: "src/long.ts", source: `${"a".repeat(498)}🚀 createUser user tail // after the limit` }),
    sym({ id: "u7", name: "orderService", file: "src/order.ts", source: "import { createUser } from './user';\nimport { parse } from '../lib/xml';\nclass OrderService { create() {} }" }),
    sym({ id: "dup", name: "alphaOnly", file: "src/dup.ts", source: "alpha only" }),
    sym({ id: "dup", name: "betaOnly", file: "src/dup.ts", source: "beta only shared" }),
    sym({ id: "same1", name: "same", file: "src/a.ts" }),
    sym({ id: "same2", name: "same", file: "src/b.ts" }),
  ];
  for (let i = 0; i < 300; i++) {
    out.push(sym({
      id: `g${i}`,
      name: `handler${i % 17}Request`,
      file: `src/gen/file${i % 23}.ts`,
      signature: i % 3 === 0 ? `(req: Request${i % 5}): Promise<void>` : undefined,
      docstring: i % 4 === 0 ? `Handles request number ${i}.` : undefined,
      source: `function handler${i % 17}Request(req) {\n  // user ${i % 7}\n  return createUser(req.body.name${i % 11});\n}`,
    }));
  }
  return out;
}

const QUERIES = [
  "create user", "createUser", "user", "http response", "xml", "σίσυφος", "alpha", "beta", "shared",
  "same", "handler request", "request promise", "legacy", "validate", "order service create",
  "user user", "a", "", "   ", "!!!", "tail", "after limit",
];

async function buildBoth(symbols: CodeSymbol[]): Promise<{ ts: BM25Index; rs: BM25Index }> {
  const ts = buildBM25Index(symbols);
  process.env["CODESIFT_NATIVE_BM25"] = "1";
  resetNativeForTesting();
  const rs = await buildBM25IndexYielding(symbols);
  return { ts, rs };
}

function expectSameRanking(ts: SearchResult[], rs: SearchResult[], label: string): void {
  expect(rs.map((r) => r.symbol.id), label).toEqual(ts.map((r) => r.symbol.id));
  for (let i = 0; i < ts.length; i++) {
    // The very same objects: the native index hands back the caller's symbols, not copies.
    expect(rs[i]!.symbol, label).toBe(ts[i]!.symbol);
    expect(rs[i]!.matches, label).toEqual(ts[i]!.matches);
    const a = ts[i]!.score;
    const b = rs[i]!.score;
    expect(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)), `${label}: ${a} vs ${b}`).toBe(true);
  }
}

/** Four fields, as an untyped caller passed them: the missing one must count as zero on both. */
const PARTIAL_WEIGHTS = { name: 3, signature: 2, docstring: 1.5, body: 1 } as unknown as typeof WEIGHTS;

function compareAll(ts: BM25Index, rs: BM25Index, stage: string): void {
  expect(rs.docCount, stage).toBe(ts.docCount);
  for (const q of ["create user", "validate user", "legacy"]) {
    expectSameRanking(searchBM25(ts, q, 50, PARTIAL_WEIGHTS), searchBM25(rs, q, 50, PARTIAL_WEIGHTS), `${stage} | partial weights ${q}`);
  }
  for (const q of QUERIES) {
    for (const topK of [1, 5, 1000]) {
      expectSameRanking(searchBM25(ts, q, topK, WEIGHTS), searchBM25(rs, q, topK, WEIGHTS), `${stage} | ${JSON.stringify(q)} top${topK}`);
    }
  }
}

describe.skipIf(!native)("native BM25 parity with the TypeScript index", () => {
  it("builds a native index when switched on", async () => {
    const { ts, rs } = await buildBoth(corpus());
    expect(isNativeBM25(ts)).toBe(false);
    expect(isNativeBM25(rs)).toBe(true);
  });

  it("ranks identically after a build", async () => {
    const { ts, rs } = await buildBoth(corpus());
    compareAll(ts, rs, "build");
  });

  it("computes the same import centrality (read by search_text ranking)", async () => {
    const { ts, rs } = await buildBoth(corpus());
    const sorted = (m: Map<string, number>) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const a = sorted(ts.centrality);
    const b = sorted(rs.centrality);
    expect(b.map(([f]) => f)).toEqual(a.map(([f]) => f));
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]![1] - b[i]![1])).toBeLessThan(1e-12);
  });

  it("ranks identically through a sequence of file updates, including a colliding id", async () => {
    const { ts, rs } = await buildBoth(corpus());
    const steps: Array<[string, CodeSymbol[]]> = [
      ["src/user.ts", [sym({ id: "u1", name: "createUser", file: "src/user.ts", source: "rewritten body user" })]],
      ["src/dup.ts", []],
      ["src/dup.ts", [sym({ id: "dup", name: "alpha", file: "src/dup.ts" })]],
      ["src/a.ts", [sym({ id: "same1", name: "same", file: "src/a.ts" })]],
      ["src/gen/file3.ts", []],
      ["src/new.ts", [sym({ id: "n1", name: "brandNewUser", file: "src/new.ts", source: "user user user" }), sym({ id: "u2", name: "movedHere", file: "src/new.ts" })]],
      ["does/not/exist.ts", []],
    ];
    for (const [file, symbols] of steps) {
      updateBM25ForFile(ts, file, symbols);
      updateBM25ForFile(rs, file, symbols);
      compareAll(ts, rs, `after update ${file}`);
      expect([...rs.symbols.keys()]).toEqual([...ts.symbols.keys()]);
    }
  });

  it("an empty corpus answers nothing on both", async () => {
    const { ts, rs } = await buildBoth([]);
    compareAll(ts, rs, "empty");
  });
});
