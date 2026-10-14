// planOverlayDelta: a re-walk of an overlay index as the files it changed (overlay-delta.ts).
import { describe, expect, it } from "vitest";
import type { CodeSymbol, FileEntry } from "../../src/types.js";
import { deltaFits, planOverlayDelta, storedEntryKey } from "../../src/tools/index-tools/overlay-delta.js";

const BASE = "local/fam:";
const WT = "local/fam@wt:";

/** Each symbol's parent is a class in the same file, named by id like the symbol itself. */
function sym(prefix: string, file: string, name: string, source = `function ${name}() {}`): CodeSymbol {
  return {
    id: `${prefix}${file}:${name}:1`, repo: "local/fam@wt", name, kind: "method", file, start_line: 1, end_line: 2, source,
    parent: `${prefix}${file}:Owner:1`,
  };
}

function entry(path: string, mtime: number, stale?: boolean): FileEntry {
  return { path, language: "typescript", symbol_count: 1, last_modified: 1, mtime_ms: mtime, ...(stale ? { stale } : {}) };
}

/** A stored index of a.ts, b.ts, c.ts — all base rows — and a walk that may have changed them. */
function plan(walk: { parsed: CodeSymbol[]; parsedPaths: string[]; entries: FileEntry[]; kept?: CodeSymbol[] }) {
  const stored = new Map([
    ["a.ts", [sym(BASE, "a.ts", "a")]],
    ["b.ts", [sym(BASE, "b.ts", "b")]],
    ["c.ts", [sym(BASE, "c.ts", "c")]],
  ]);
  const storedEntries = new Map(["a.ts", "b.ts", "c.ts"].map((p) => [p, storedEntryKey(entry(p, 1))]));
  const kept = walk.kept ?? [];
  return planOverlayDelta({
    storedSymbolsByFile: stored,
    storedEntries,
    parsedPaths: new Set(walk.parsedPaths),
    symbols: [...kept, ...walk.parsed],
    entries: walk.entries,
    idPrefixes: [WT, BASE],
  });
}

describe("planOverlayDelta", () => {
  // Bug it catches: a re-parse of unchanged content read as a change because its ids (and its parent
  // ids) carry the worktree's prefix — every re-parsed file copied into the overlay, and search hits
  // naming ids the store does not hold.
  it("keeps the stored rows of a re-parsed file whose content did not change", () => {
    const p = plan({
      parsed: [sym(WT, "a.ts", "a")],
      parsedPaths: ["a.ts"],
      entries: [entry("a.ts", 1), entry("b.ts", 1), entry("c.ts", 1)],
      kept: [sym(BASE, "b.ts", "b"), sym(BASE, "c.ts", "c")],
    });
    expect(p.delta).toEqual({ replaced: [], entries: [], removed: [] });
    expect(p.symbols.map((s) => s.id).sort()).toEqual([`${BASE}a.ts:a:1`, `${BASE}b.ts:b:1`, `${BASE}c.ts:c:1`]);
  });

  // Bug it catches: each kind of change landing in the wrong bucket — an edit written as a file row
  // alone (old symbols stay), a new mtime written as a symbol rewrite (the overlay grows), or a
  // deleted file left in the index.
  it("sorts a walk's changes into rewrites, file rows and removals", () => {
    const p = plan({
      parsed: [sym(WT, "a.ts", "a", "function a() { return 1; }")],
      parsedPaths: ["a.ts"],
      entries: [entry("a.ts", 9), entry("b.ts", 5)],
      kept: [sym(BASE, "b.ts", "b")],
    });
    expect(p.delta.replaced.map((r) => [r.path, r.symbols.map((s) => s.source)])).toEqual([["a.ts", ["function a() { return 1; }"]]]);
    expect(p.delta.entries.map((e) => [e.path, e.mtime_ms])).toEqual([["b.ts", 5]]);
    expect(p.delta.removed).toEqual(["c.ts"]);
    expect(p.changedFiles).toBe(2);
  });

  // Bug it catches: a stale mark set in place by dirty propagation compared against the same object,
  // so the mark never reaches the database and the caller is never re-parsed.
  it("writes an entry marked stale after the stored entries were taken", () => {
    const b = entry("b.ts", 1);
    const p = plan({ parsed: [], parsedPaths: [], entries: [entry("a.ts", 1), b, entry("c.ts", 1)], kept: [sym(BASE, "a.ts", "a"), sym(BASE, "b.ts", "b"), sym(BASE, "c.ts", "c")] });
    expect(p.delta.entries).toEqual([]);
    b.stale = true;
    const marked = plan({ parsed: [], parsedPaths: [], entries: [entry("a.ts", 1), b, entry("c.ts", 1)], kept: [sym(BASE, "a.ts", "a"), sym(BASE, "b.ts", "b"), sym(BASE, "c.ts", "c")] });
    expect(marked.delta.entries.map((e) => e.path)).toEqual(["b.ts"]);
  });

  // Bug it catches: a delta of most of the tree written in one synchronous transaction, or a small
  // repo never allowed a delta at all.
  it.each([
    { name: "a quarter of a large tree fits", changed: 2_500, files: 10_000, fits: true },
    { name: "more than a quarter does not", changed: 2_501, files: 10_000, fits: false },
    { name: "a small tree gets the 64-file floor", changed: 64, files: 100, fits: true },
  ])("$name", ({ changed, files, fits }) => {
    expect(deltaFits({ delta: { replaced: [], entries: [], removed: [] }, symbols: [], changedFiles: changed }, files)).toBe(fits);
  });
});
