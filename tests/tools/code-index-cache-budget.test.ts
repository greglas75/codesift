// Bug it catches: `codeIndexes` (the tool-level cache of loaded indexes) had no bound, so the daemon
// kept every repo it ever loaded — 9 indexes / 4.9 GB over a 4 GB budget on 2026-10-09 — because the
// byte budget only governed the storage-level cache underneath it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeIndexes, rememberCodeIndex, touchCodeIndex } from "../../src/tools/index-tools/state.js";
import { recordIndexFootprint } from "../../src/storage/index-footprint.js";
import type { CodeIndex } from "../../src/types.js";

const MB = 1024 * 1024;
let previous: string | undefined;

function index(repo: string, bytes: number): CodeIndex {
  const idx: CodeIndex = { repo, root: `/tmp/${repo}`, symbols: [], files: [], created_at: 0, updated_at: 0, symbol_count: 0, file_count: 0 };
  recordIndexFootprint(idx, bytes);
  return idx;
}

beforeEach(() => {
  previous = process.env["CODESIFT_MAX_INDEX_CACHE_MB"];
  process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = "100";
  codeIndexes.clear();
});

afterEach(() => {
  if (previous === undefined) delete process.env["CODESIFT_MAX_INDEX_CACHE_MB"];
  else process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = previous;
  codeIndexes.clear();
});

describe("codeIndexes byte budget", () => {
  it("evicts the least recently used index once the budget is exceeded", () => {
    rememberCodeIndex("a", index("a", 40 * MB));
    rememberCodeIndex("b", index("b", 40 * MB));
    touchCodeIndex("a"); // a is now the most recently used
    rememberCodeIndex("c", index("c", 40 * MB)); // 120 MB > 100 MB: b goes, not a
    expect([...codeIndexes.keys()]).toEqual(["a", "c"]);
  });

  it("keeps the most recent index even when it alone exceeds the budget", () => {
    rememberCodeIndex("small", index("small", 10 * MB));
    rememberCodeIndex("huge", index("huge", 500 * MB));
    expect([...codeIndexes.keys()]).toEqual(["huge"]);
  });
});
