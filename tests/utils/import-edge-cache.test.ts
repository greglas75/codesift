// Remembering what each file imported, so an unchanged file is never parsed again.
//
// Profiled on tgm-survey-platform (16,896 files, 149 MB): reading every file off disk is 0.8 s;
// extracting its imports is 14.8 s — 95% of the graph build. Parsing is a pure function of the
// content, and most files do not change between two calls.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEdgeCache,
  saveEdgeCache,
  edgeCachePathFor,
  fileSetHash,
  type EdgeCache,
} from "../../src/utils/import-graph/edge-cache.js";
import type { FileEntry } from "../../src/types.js";

let dir: string;
let indexPath: string;

const file = (path: string, mtime: number): FileEntry => ({
  path,
  language: "typescript",
  symbol_count: 1,
  last_modified: mtime,
  mtime_ms: mtime,
});

const FILES = [file("a.ts", 100), file("b.ts", 200)];

function cacheOf(): EdgeCache {
  return new Map([
    ["a.ts", { mtime: 100, calls: [{ to: "b.ts" }, { to: "c.ts", extras: { type_only: true } }] }],
    ["b.ts", { mtime: 200, calls: [] }],
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-edgecache-"));
  indexPath = join(dir, "abc123.index.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("import edge cache", () => {
  it("round-trips the recorded calls, extras included", async () => {
    await saveEdgeCache(indexPath, FILES, cacheOf());
    const back = await loadEdgeCache(indexPath, FILES);

    expect(back).not.toBeNull();
    expect(back!.get("a.ts")).toEqual({
      mtime: 100,
      calls: [{ to: "b.ts" }, { to: "c.ts", extras: { type_only: true } }],
    });
    // A file that imports nothing is a real answer and must survive the round trip: dropping it
    // would make it look uncached and re-parse it forever.
    expect(back!.get("b.ts")).toEqual({ mtime: 200, calls: [] });
  });

  it("refuses the whole cache when the FILE SET changed", async () => {
    // An edge is not a function of its source alone: `import "./foo"` resolves against the paths
    // that exist, so adding or deleting a file elsewhere can change where an UNTOUCHED file points.
    // Per-file mtimes cannot see that.
    await saveEdgeCache(indexPath, FILES, cacheOf());

    expect(await loadEdgeCache(indexPath, [...FILES, file("c.ts", 300)])).toBeNull();
    expect(await loadEdgeCache(indexPath, [FILES[0]!])).toBeNull();
    // Same set, different order — that is the same set, and re-parsing it would be waste.
    expect(await loadEdgeCache(indexPath, [FILES[1]!, FILES[0]!])).not.toBeNull();
  });

  it("hashes the file set by content, not by order", () => {
    expect(fileSetHash([FILES[0]!, FILES[1]!])).toBe(fileSetHash([FILES[1]!, FILES[0]!]));
    expect(fileSetHash(FILES)).not.toBe(fileSetHash([...FILES, file("c.ts", 1)]));
  });

  it("returns null rather than half a graph when the file is truncated", async () => {
    await saveEdgeCache(indexPath, FILES, cacheOf());
    const p = edgeCachePathFor(indexPath);
    writeFileSync(p, `${readFileSync(p, "utf-8").split("\n")[0]}\n["a.ts", 100, [[`);
    expect(await loadEdgeCache(indexPath, FILES)).toBeNull();
  });

  it("returns null when there is no cache at all", async () => {
    expect(await loadEdgeCache(indexPath, FILES)).toBeNull();
  });

  it("leaves no temp file behind, so an interrupted write cannot be read as complete", async () => {
    await saveEdgeCache(indexPath, FILES, cacheOf());
    expect(existsSync(edgeCachePathFor(indexPath))).toBe(true);
    expect(existsSync(`${edgeCachePathFor(indexPath)}.tmp.${process.pid}`)).toBe(false);
  });

  it("derives its path from either index naming", () => {
    expect(edgeCachePathFor("/x/abc.index.db")).toBe("/x/abc.import-edges.ndjson");
    expect(edgeCachePathFor("/x/abc.index.json")).toBe("/x/abc.import-edges.ndjson");
  });
});
