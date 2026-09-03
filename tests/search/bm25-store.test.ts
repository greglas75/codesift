// Persisting the BM25 index next to the code index it was built from.
//
// A rebuild costs 10.04 s on the largest repo here (352,166 symbols, 12.9M tokens) and is paid once
// per repo per process — every daemon restart, and every eviction under the cache budget, charges it
// again. Measured alternative on the same index: reconstructing the maps from flat arrays is 0.70 s,
// reading 400 MB off this disk 0.06 s. The expensive half of a build is TOKENISING every symbol, and
// that result does not change until the index does.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBM25Index, searchBM25 } from "../../src/search/bm25.js";
import { saveBM25Index, loadBM25Index, bm25PathFor } from "../../src/search/bm25-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

const WEIGHTS = { name: 3.0, signature: 2.0, docstring: 1.5, body: 1.0, comments: 0.5 };

function sym(over: Partial<CodeSymbol> & { id: string; name: string }): CodeSymbol {
  return { repo: "t", kind: "function", file: "a.ts", start_line: 1, end_line: 5, ...over };
}

const symbols: CodeSymbol[] = [
  sym({ id: "1", name: "getUserById", signature: "getUserById(id: string): User" }),
  sym({ id: "2", name: "createInvoice", file: "b.ts", source: "// bills the customer\nfunction createInvoice() {}" }),
  sym({ id: "3", name: "quarkHandler", file: "b.ts", docstring: "handles quarks" }),
];

function codeIndex(over: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "t", root: "/tmp/t", files: [{ path: "a.ts" }, { path: "b.ts" }] as never,
    symbols, created_at: 1, updated_at: 1000, ...over,
  } as CodeIndex;
}

let dir: string;
let indexPath: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-bm25store-")); indexPath = join(dir, "x.index.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("BM25 sidecar", () => {
  it("round-trips to an index that searches identically", async () => {
    const built = buildBM25Index(symbols);
    const code = codeIndex();
    await saveBM25Index(indexPath, built, code);

    const restored = await loadBM25Index(indexPath, code);
    expect(restored).not.toBeNull();

    for (const q of ["getUserById", "createInvoice", "quarkHandler", "customer"]) {
      expect(searchBM25(restored!, q, 5, WEIGHTS).map((r) => r.symbol.id))
        .toEqual(searchBM25(built, q, 5, WEIGHTS).map((r) => r.symbol.id));
    }
    expect(restored!.docCount).toBe(built.docCount);
    expect(restored!.avgFieldLengths).toEqual(built.avgFieldLengths);
    expect(restored!.totalFieldLengths).toEqual(built.totalFieldLengths);
  });

  it("does not persist the symbols — they are already in the code index", async () => {
    // Writing them again would double the bytes on a disk that is, on this machine, the bottleneck.
    await saveBM25Index(indexPath, buildBM25Index(symbols), codeIndex());
    const raw = readFileSync(bm25PathFor(indexPath), "utf-8");
    expect(raw).not.toContain("start_line");
    expect(raw).not.toContain("\"kind\"");
    // …and they come back anyway, reattached from the index.
    const restored = await loadBM25Index(indexPath, codeIndex());
    expect(restored!.symbols.get("1")?.name).toBe("getUserById");
  });

  it("refuses a sidecar whose index has changed underneath it", async () => {
    // A cache that does not describe the current index is worse than no cache: it returns
    // confident, wrong search results, which is the one failure a search tool must never have.
    await saveBM25Index(indexPath, buildBM25Index(symbols), codeIndex());

    expect(await loadBM25Index(indexPath, codeIndex({ updated_at: 2000 }))).toBeNull();
    expect(await loadBM25Index(indexPath, codeIndex({ symbols: symbols.slice(0, 2) }))).toBeNull();
    expect(await loadBM25Index(indexPath, codeIndex({ files: [{ path: "a.ts" }] as never }))).toBeNull();
  });

  it("returns null rather than half an index when the file is truncated", async () => {
    await saveBM25Index(indexPath, buildBM25Index(symbols), codeIndex());
    const p = bm25PathFor(indexPath);
    const half = readFileSync(p, "utf-8").split("\n").slice(0, 3).join("\n") + "\n{ truncated";
    writeFileSync(p, half);
    expect(await loadBM25Index(indexPath, codeIndex())).toBeNull();
  });

  it("returns null when there is no sidecar at all", async () => {
    expect(await loadBM25Index(indexPath, codeIndex())).toBeNull();
  });

  it("leaves no temp file behind, so an interrupted write cannot be read as complete", async () => {
    await saveBM25Index(indexPath, buildBM25Index(symbols), codeIndex());
    expect(existsSync(bm25PathFor(indexPath))).toBe(true);
    expect(existsSync(`${bm25PathFor(indexPath)}.tmp.${process.pid}`)).toBe(false);
  });
});
