import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadIndexSummarySqlite,
  saveIndexSqlite,
  loadIndexSqlite,
  closeAllIndexDbs,
} from "../../src/storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";

const describeWithSqlite = HAS_NODE_SQLITE ? describe : describe.skip;

/**
 * The narrow read (ADR-004 stage 2). Its whole value is that it does NOT build symbols, so the
 * things worth pinning are that it still agrees with the full load about everything it does
 * report — a summary that quietly disagreed would be worse than no summary at all.
 */

let dir: string;
let dbPath: string;

function sym(file: string, name: string, line: number): CodeSymbol {
  return {
    id: `test:${file}:${name}:${line}`,
    repo: "test/repo",
    name,
    kind: "function",
    file,
    start_line: line,
    end_line: line + 1,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  const paths = [...new Set(symbols.map((s) => s.file))];
  return {
    repo: "test/repo",
    root: "/tmp/root",
    symbols,
    files: paths.map((path) => ({
      path,
      language: "typescript",
      symbol_count: symbols.filter((s) => s.file === path).length,
      last_modified: 7,
    })),
    created_at: 11,
    updated_at: 22,
    symbol_count: symbols.length,
    file_count: paths.length,
    extractor_version: { typescript: "9.9.9" },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-summary-"));
  dbPath = join(dir, "x.index.db");
});

afterEach(async () => {
  closeAllIndexDbs();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describeWithSqlite("loadIndexSummarySqlite", () => {
  it("agrees with the full load on every field it reports", async () => {
    const symbols = Array.from({ length: 40 }, (_, i) => sym(`f${i % 7}.ts`, `fn${i}`, i + 1));
    await saveIndexSqlite(dbPath, makeIndex(symbols));

    const full = await loadIndexSqlite(dbPath);
    const summary = await loadIndexSummarySqlite(dbPath);

    expect(summary).not.toBeNull();
    expect(summary!.repo).toBe(full!.repo);
    expect(summary!.root).toBe(full!.root);
    expect(summary!.created_at).toBe(full!.created_at);
    expect(summary!.updated_at).toBe(full!.updated_at);
    expect(summary!.file_count).toBe(full!.file_count);
    expect(summary!.extractor_version).toEqual(full!.extractor_version);
    // The count comes from SQL rather than an array length — the one number most likely to drift.
    expect(summary!.symbol_count).toBe(full!.symbol_count);
    expect(summary!.symbol_count).toBe(40);
    // Same files, same order: both SQLite read paths walk by rowid.
    expect(summary!.files.map((f) => f.path)).toEqual(full!.files.map((f) => f.path));
  });

  it("has no symbols field at all — not an empty array", async () => {
    // An empty array is a lie a caller cannot detect: iterating it reads as "this repo has no
    // symbols". Absence makes a consumer that needs them fail to compile instead.
    await saveIndexSqlite(dbPath, makeIndex([sym("a.ts", "a", 1)]));
    const summary = await loadIndexSummarySqlite(dbPath);
    expect(summary).not.toBeNull();
    expect("symbols" in (summary as object)).toBe(false);
  });

  it("returns null for a database with no index, without reporting a fault", async () => {
    const empty = join(dir, "empty.index.db");
    expect(await loadIndexSummarySqlite(empty)).toBeNull();
  });

  it("carries the lossy-migration marker through, so status can report it", async () => {
    await saveIndexSqlite(dbPath, makeIndex([sym("a.ts", "a", 1)]), { sourceComplete: true });
    expect((await loadIndexSummarySqlite(dbPath))!.lossy_migration).toBeUndefined();
  });

  it("counts symbols the SQL way even when the stored index disagreed", async () => {
    // symbol_count is recomputed, not echoed — a stale stored count cannot leak into status.
    const index = makeIndex([sym("a.ts", "a", 1), sym("a.ts", "b", 2)]);
    index.symbol_count = 999; // deliberately wrong
    await saveIndexSqlite(dbPath, index);
    expect((await loadIndexSummarySqlite(dbPath))!.symbol_count).toBe(2);
  });
});

describeWithSqlite("summary staleness agrees with the full-load path", () => {
  it("does not report an untracked-language index as never-indexed", async () => {
    // BEHAV-1: `isExtractorVersionCurrent` short-circuits on a missing `extractor_version`, while
    // `collectExtractorVersionMismatches` only flags languages actually present in `files`. An
    // index in languages absent from EXTRACTOR_VERSIONS loaded fine via getCodeIndex and came back
    // null via the summary — and index_status then reported `indexed: false` with no diagnostic.
    const { collectExtractorVersionMismatches } = await import("../../src/storage/index-store.js");
    const untracked = {
      extractor_version: undefined,
      files: [{ path: "main.go", language: "go", symbol_count: 1, last_modified: 1 }],
    };
    expect(collectExtractorVersionMismatches(untracked, { typescript: "1.0.0" })).toEqual([]);
  });
});

describeWithSqlite("summary cache", () => {
  it("serves a repeat read from cache and hands back a copy, not the stored object", async () => {
    const { loadIndexSummary, resetSummaryCacheForTesting } = await import(
      "../../src/storage/index-store.js"
    );
    process.env["CODESIFT_INDEX_BACKEND"] = "sqlite";
    resetSummaryCacheForTesting();
    const jsonPath = join(dir, "cached.index.json");
    await saveIndexSqlite(join(dir, "cached.index.db"), makeIndex([sym("a.ts", "a", 1)]));

    const first = await loadIndexSummary(jsonPath);
    const second = await loadIndexSummary(jsonPath);
    expect(first!.symbol_count).toBe(1);
    expect(second!.symbol_count).toBe(1);

    // Mutating one caller's copy must not reach the next reader — the boundary `copyIndex`
    // defends for full indexes, applied to the narrow shape as well.
    first!.files.length = 0;
    const third = await loadIndexSummary(jsonPath);
    expect(third!.files).toHaveLength(1);

    resetSummaryCacheForTesting();
    delete process.env["CODESIFT_INDEX_BACKEND"];
  });
});
