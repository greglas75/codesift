// v1 wrote the full symbol id — `repo:file:name:line`, averaging 121 characters — into every postings
// entry, and a document appears once per token it contains. Measured on a real 53 MB index: 398,712
// postings pairs over 17,410 distinct ids, 22.9 repeats each, and 91% of the file was id strings.
//
// That made the persisted cache not worth its disk. On the largest conversation index here (160,626
// turns) v1 produced a 1,975 MB file and loading it was 1.4x faster than rebuilding from scratch —
// parsing two billion characters of repeated strings costs about what tokenising the corpus costs.
//
// v2 writes the ids once, in a chunked table before the postings, and references them by index.
// Measured after: 1,975 MB -> 165 MB and 1.4x -> 4.26x on that index; 20.3x and 12.1x on the next two.
//
// These cover the two things that could make it silently wrong rather than merely large: a reference
// that resolves to the wrong symbol, and a reference that resolves to none.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBM25Index, searchBM25 } from "../../src/search/bm25.js";
import { saveBM25Index, loadBM25Index, bm25PathFor } from "../../src/search/bm25-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

let dir: string;
let indexPath: string;

function symbol(i: number, text: string): CodeSymbol {
  return {
    id: `local/repo:src/very/deeply/nested/path/module-${i}.ts:handlerNumber${i}:${i * 7}`,
    name: `handlerNumber${i}`,
    kind: "function",
    file: `src/very/deeply/nested/path/module-${i}.ts`,
    line: i * 7,
    signature: `function handlerNumber${i}(input: string): void`,
    source: text,
  } as unknown as CodeSymbol;
}

function codeIndexOf(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "local/repo",
    root: "/tmp/repo",
    symbols,
    files: symbols.map((s) => ({
      path: s.file, language: "typescript", symbol_count: 1, last_modified: 1,
    })),
    created_at: 1,
    updated_at: 1,
    symbol_count: symbols.length,
    file_count: symbols.length,
  } as unknown as CodeIndex;
}

/** A corpus with heavy token sharing, which is what makes ids repeat in the first place. */
function corpus(n: number): CodeSymbol[] {
  const words = ["retention", "budget", "eviction", "orphan", "conversation", "postings", "token"];
  return Array.from({ length: n }, (_, i) =>
    symbol(i, `${words.join(" ")} ${words[i % words.length]} unique${i}`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-bm25v2-"));
  indexPath = join(dir, "abc123.index.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bm25 store v2 — interned symbol ids", () => {
  it("round-trips postings, field lengths and totals exactly", async () => {
    const code = codeIndexOf(corpus(40));
    const built = buildBM25Index(code.symbols);
    await saveBM25Index(indexPath, built, code);

    const back = await loadBM25Index(indexPath, code);
    expect(back).not.toBeNull();
    expect(back!.docCount).toBe(built.docCount);
    expect(back!.totalFieldLengths).toEqual(built.totalFieldLengths);
    expect(back!.fieldLengths.size).toBe(built.fieldLengths.size);
    for (const [id, lengths] of built.fieldLengths) {
      expect(back!.fieldLengths.get(id)).toEqual(lengths);
    }
    for (const field of ["name", "signature", "docstring", "body", "comments"] as const) {
      expect(back!.fields[field].size).toBe(built.fields[field].size);
      for (const [token, postings] of built.fields[field]) {
        expect([...(back!.fields[field].get(token) ?? new Map())]).toEqual([...postings]);
      }
    }
  });

  it("searches the reloaded index to the same ranking as the built one", () => {
    // Postings equality is structural; this is the behaviour that structure exists for. An off-by-one
    // in the id table would still produce a well-formed index that ranked the wrong symbols.
    const code = codeIndexOf(corpus(40));
    const built = buildBM25Index(code.symbols);
    return (async () => {
      await saveBM25Index(indexPath, built, code);
      const back = await loadBM25Index(indexPath, code);
      const weights = { name: 3, signature: 2, docstring: 1.5, body: 1, comments: 0.5 };
      const a = searchBM25(built, "retention budget", 10, weights).map((r) => r.symbol.id);
      const b = searchBM25(back!, "retention budget", 10, weights).map((r) => r.symbol.id);
      expect(b).toEqual(a);
      expect(a.length).toBeGreaterThan(0);
    })();
  });

  it("writes each id once, not once per posting", async () => {
    const code = codeIndexOf(corpus(40));
    const built = buildBM25Index(code.symbols);
    await saveBM25Index(indexPath, built, code);
    const text = readFileSync(bm25PathFor(indexPath), "utf-8");
    // Every id appears in the table line and in its own `["l", …]` record — and nowhere else. In v1 it
    // appeared once per (token, field) it occurred in, which is the 22.9x.
    const id = code.symbols[3]!.id;
    const occurrences = text.split(id).length - 1;
    expect(occurrences).toBe(1);
  });

  it("spans several id-table chunks without shifting a posting", async () => {
    // The chunk bound exists so one JSON array cannot hit V8's string ceiling on a large repo. A
    // chunk that were read at the wrong offset would attach the wrong symbol to every posting after it
    // and still look like a valid index, so this covers more than one chunk being written.
    const code = codeIndexOf(corpus(120));
    const built = buildBM25Index(code.symbols);
    await saveBM25Index(indexPath, built, code);
    const lines = readFileSync(bm25PathFor(indexPath), "utf-8").split("\n").filter(Boolean);
    const tableLines = lines.filter((l) => l.startsWith('["s"'));
    expect(tableLines.length).toBeGreaterThanOrEqual(1);
    const back = await loadBM25Index(indexPath, code);
    for (const [id, lengths] of built.fieldLengths) {
      expect(back!.fieldLengths.get(id)).toEqual(lengths);
    }
  });

  it("rebuilds rather than guessing when a reference has no entry in the table", async () => {
    // The one failure that must not degrade into a wrong answer. Returning null sends the caller to a
    // rebuild, which is always correct; inventing an id would serve a confident wrong symbol.
    const code = codeIndexOf(corpus(20));
    const built = buildBM25Index(code.symbols);
    await saveBM25Index(indexPath, built, code);
    const path = bm25PathFor(indexPath);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    // Drop the id table, keep everything else.
    writeFileSync(path, `${lines.filter((l) => !l.startsWith('["s"')).join("\n")}\n`);

    expect(await loadBM25Index(indexPath, code)).toBeNull();
  });

  it("rejects a v1 file so an existing cache migrates instead of being misread", async () => {
    const code = codeIndexOf(corpus(10));
    const built = buildBM25Index(code.symbols);
    await saveBM25Index(indexPath, built, code);
    const path = bm25PathFor(indexPath);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const header = JSON.parse(lines[0]!) as { v: number };
    header.v = 1;
    writeFileSync(path, `${[JSON.stringify(header), ...lines.slice(1)].join("\n")}\n`);

    expect(await loadBM25Index(indexPath, code)).toBeNull();
  });
});
