import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { ARTIFACT_SUFFIXES, artifactPattern } from "../../src/storage/_shared.js";
import { getChunkPath, getChunkEmbeddingPath } from "../../src/storage/chunk-store.js";
import { sqlitePathFor, getIndexPath } from "../../src/storage/index-store.js";

/**
 * `prune` reclaims a file only when it matches `<hash>.<known suffix>`, so a suffix the
 * list does not know about is a file nothing will ever delete — and prune still reports
 * success, which reads as "clean" rather than "I did not recognise most of this".
 *
 * That is not hypothetical: the list predated the chunk store and the SQLite backend, so
 * it knew `embeddings.ndjson` but not `chunks.ndjson`, `chunk-embeddings.ndjson`,
 * `index.db` or `snapshot.json`. On this machine that left 2,206 files and 8.72 GB
 * unreclaimable while prune reported 0.93 GB.
 *
 * These tests tie the list to the helpers that BUILD the names, so adding an artifact kind
 * without teaching prune about it fails here.
 */
const INDEX_PATH = getIndexPath("/data", "/repo");

describe("prune recognises every artifact the storage layer creates", () => {
  it("matches the names the path helpers actually produce", () => {
    const re = artifactPattern();
    const produced = [
      INDEX_PATH,
      sqlitePathFor(INDEX_PATH),
      getChunkPath(INDEX_PATH),
      getChunkEmbeddingPath(INDEX_PATH),
      INDEX_PATH.replace(/\.index\.json$/, ".embeddings.ndjson"),
      INDEX_PATH.replace(/\.index\.json$/, ".embeddings.meta.json"),
      INDEX_PATH.replace(/\.index\.json$/, ".snapshot.json"),
    ];
    for (const p of produced) {
      expect(re.test(basename(p)), `prune would not reclaim ${basename(p)}`).toBe(true);
    }
  });

  it("reclaims the WAL and shm that a killed process leaves beside a database", () => {
    const re = artifactPattern();
    const db = basename(sqlitePathFor(INDEX_PATH));
    expect(re.test(db + "-wal")).toBe(true);
    expect(re.test(db + "-shm")).toBe(true);
  });

  it("reclaims the abandoned half of an interrupted atomic write", () => {
    const re = artifactPattern();
    expect(re.test("a1b2c3d4e5f6.embeddings.ndjson.tmp.1785000000000")).toBe(true);
  });

  it("leaves shared and non-repo files alone", () => {
    const re = artifactPattern();
    for (const f of ["registry.json", "host-id", "shared-embeddings.v1.ndjson", "logs", "wiki-regen-debounce.json"]) {
      expect(re.test(f), `${f} must not be treated as a repo artifact`).toBe(false);
    }
  });

  it("captures the hash, which is what identifies the owning repo", () => {
    const m = artifactPattern().exec(basename(sqlitePathFor(INDEX_PATH)));
    expect(m?.[1]).toBe(basename(INDEX_PATH).split(".")[0]);
  });

  it("keeps the list free of duplicates", () => {
    expect(new Set(ARTIFACT_SUFFIXES).size).toBe(ARTIFACT_SUFFIXES.length);
  });
});
