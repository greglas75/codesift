// The persisted native BM25 index (ADR-006 stage 9, reopened): a cold first search on a 1.43M-symbol
// index cost ~20 s per worktree, of which 13.9 s was the build a saved index skips.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeCore } from "../../src/native/index.js";
import { buildBM25IndexYielding, isNativeBM25, searchBM25 } from "../../src/search/bm25.js";
import { filesToReapply, loadNativeBM25, nativeBm25PathFor, saveNativeBM25 } from "../../src/search/bm25-native-store.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

const WEIGHTS = { name: 3, signature: 1, docstring: 1.5, body: 1, comments: 0.5 };

function sym(file: string, name: string, source: string, line = 1): CodeSymbol {
  return { id: `r:${file}:${name}:${line}`, repo: "r", file, name, kind: "function", start_line: line, end_line: line + 2, source };
}

function file(path: string, mtime: number, symbol_count: number): FileEntry {
  return { path, language: "typescript", symbol_count, last_modified: mtime, mtime_ms: mtime };
}

function index(symbols: CodeSymbol[], files: FileEntry[]): CodeIndex {
  return { repo: "r", root: "/r", symbols, files, created_at: 1, updated_at: 2, extractor_version: { typescript: 3 } } as CodeIndex;
}

const ids = (hits: ReturnType<typeof searchBM25>) => hits.map((h) => [h.symbol.id, h.score.toFixed(9)]);

describe("filesToReapply", () => {
  const code = index([], [file("a.ts", 10, 1), file("b.ts", 20, 2)]);
  const header = (files: Array<[string, string]>, extra: Partial<{ codesift: string; extractor: string; format: number }> = {}) => ({
    format: 1,
    codesift: (createRequire(import.meta.url)("../../package.json") as { version: string }).version,
    extractor: JSON.stringify({ typescript: 3 }),
    files,
    ...extra,
  });

  it.each([
    ["nothing changed", [["a.ts", "10|1"], ["b.ts", "20|2"]], []],
    ["a file edited", [["a.ts", "9|1"], ["b.ts", "20|2"]], ["a.ts"]],
    ["a file deleted since", [["a.ts", "10|1"], ["b.ts", "20|2"], ["gone.ts", "5|1"]], ["gone.ts"]],
  ] as Array<[string, Array<[string, string]>, string[]]>)("re-applies only what differs: %s", (_case, files, expected) => {
    expect(filesToReapply(header(files), code)).toEqual(expected);
  });

  // Bug it catches: tokens from another extractor or codesift version served from a file whose
  // mtimes all still match.
  it.each([
    ["another extractor", { extractor: JSON.stringify({ typescript: 4 }) }],
    ["another codesift version", { codesift: "0.0.1" }],
    ["another header format", { format: 2 }],
  ])("rebuilds after %s", (_case, extra) => {
    expect(filesToReapply(header([["a.ts", "10|1"], ["b.ts", "20|2"]], extra), code)).toBeNull();
  });

  it("rebuilds when more than half the files changed", () => {
    expect(filesToReapply(header([["a.ts", "1|1"], ["b.ts", "1|1"]]), code)).toBeNull();
  });
});

const core = getNativeCore("bm25");

describe.skipIf(!core)("save and load", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-bm25n-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const symbolsV1 = [
    sym("a.ts", "createUser", "function createUser() { return db.insert(user); }"),
    sym("b.ts", "UserModel", "class UserModel { save() {} }"),
    sym("c.test.ts", "spec", "it('creates a user', () => createUser())"),
  ];
  const filesV1 = [file("a.ts", 10, 1), file("b.ts", 20, 1), file("c.test.ts", 30, 1)];

  // Bug it catches: a loaded index that ranks differently from a fresh build of the same symbols.
  it("answers like a fresh build after a round trip", async () => {
    const indexPath = join(dir, "abcdef012345.index.db");
    const code = index(symbolsV1, filesV1);
    const built = await buildBM25IndexYielding(symbolsV1);
    if (!isNativeBM25(built)) throw new Error("expected a native index");
    await saveNativeBM25(built, indexPath, code);

    const loaded = await loadNativeBM25(core!, indexPath, code);
    expect(loaded).not.toBeNull();
    for (const q of ["user", "create user", "save", "spec"]) {
      expect(ids(searchBM25(loaded!, q, 10, WEIGHTS))).toEqual(ids(searchBM25(built, q, 10, WEIGHTS)));
    }
  });

  // Bug it catches: an edit made after the save served from the stale postings.
  it("re-applies a file edited after the save", async () => {
    const indexPath = join(dir, "abcdef012345.index.db");
    const built = await buildBM25IndexYielding(symbolsV1);
    if (!isNativeBM25(built)) throw new Error("expected a native index");
    await saveNativeBM25(built, indexPath, index(symbolsV1, filesV1));

    const edited = [symbolsV1[0]!, sym("b.ts", "AccountModel", "class AccountModel { archive() {} }"), symbolsV1[2]!];
    const filesV2 = [file("a.ts", 10, 1), file("b.ts", 25, 1), file("c.test.ts", 30, 1)];
    const loaded = await loadNativeBM25(core!, indexPath, index(edited, filesV2));

    expect(searchBM25(loaded!, "archive", 5, WEIGHTS).map((h) => h.symbol.name)).toEqual(["AccountModel"]);
    expect(searchBM25(loaded!, "UserModel", 5, WEIGHTS).map((h) => h.symbol.name)).not.toContain("UserModel");
  });

  it("ignores a damaged file instead of failing the search", async () => {
    const indexPath = join(dir, "abcdef012345.index.db");
    writeFileSync(nativeBm25PathFor(indexPath), "not an index");
    expect(await loadNativeBM25(core!, indexPath, index(symbolsV1, filesV1))).toBeNull();
  });
});
