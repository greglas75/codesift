import { afterEach, describe, expect, it } from "vitest";
import {
  collectExtractorVersionMismatches as facadeCollectVersionMismatches,
  getIndexCacheSizeForTesting as facadeCacheSize,
  getIndexWriteCountForTesting as facadeWriteCount,
  isExtractorVersionCurrent as facadeIsVersionCurrent,
  resetIndexBackendForTesting as facadeResetBackend,
  resetIndexCacheForTesting as facadeResetCache,
  resetIndexWriteCountForTesting as facadeResetWriteCount,
  resetMigrationCacheForTesting as facadeResetMigration,
  resolveIndexBackend as facadeResolveBackend,
  sqlitePathFor as facadeSqlitePathFor,
} from "../../src/storage/index-store.js";
import {
  cacheLoadedIndex,
  getCachedIndex,
  getIndexCacheSizeForTesting,
  resetIndexCacheForTesting,
} from "../../src/storage/index-cache.js";
import {
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resolveIndexBackend,
  sqlitePathFor,
} from "../../src/storage/index-migration.js";
import {
  getIndexWriteCountForTesting,
  resetIndexWriteCountForTesting,
} from "../../src/storage/index-json-mutations.js";
import {
  collectExtractorVersionMismatches,
  isExtractorVersionCurrent,
} from "../../src/storage/index-version.js";
import type { CodeIndex } from "../../src/types.js";

const emptyIndex: CodeIndex = {
  repo: "test/repo",
  root: "/tmp/repo",
  symbols: [],
  files: [],
  created_at: 1,
  updated_at: 1,
  symbol_count: 0,
  file_count: 0,
};

describe("index-store facade", () => {
  afterEach(() => {
    resetIndexCacheForTesting();
    resetIndexWriteCountForTesting();
    resetIndexBackendForTesting();
    resetMigrationCacheForTesting();
  });

  it("re-exports cache helpers from the module that owns the cache state", () => {
    expect(facadeResetCache).toBe(resetIndexCacheForTesting);
    expect(facadeCacheSize).toBe(getIndexCacheSizeForTesting);
  });

  it("shares cache state between direct helpers and the public facade", () => {
    resetIndexCacheForTesting();
    cacheLoadedIndex("/tmp/test.index.db", emptyIndex, 1);

    expect(facadeCacheSize()).toBe(1);
    facadeResetCache();
    expect(getIndexCacheSizeForTesting()).toBe(0);
  });

  it("returns a cached index only for the matching data version", () => {
    cacheLoadedIndex("/tmp/versioned.index.db", emptyIndex, 7);

    expect(getCachedIndex("/tmp/versioned.index.db", 7)).toEqual(emptyIndex);
    expect(getCachedIndex("/tmp/versioned.index.db", 8)).toBeNull();
  });

  it("refreshes full-index LRU order on a cache hit", () => {
    for (const name of ["a", "b", "c"]) {
      cacheLoadedIndex(`/tmp/${name}.index.db`, { ...emptyIndex, repo: name }, 1);
    }

    expect(getCachedIndex("/tmp/a.index.db", 1)?.repo).toBe("a");
    cacheLoadedIndex("/tmp/d.index.db", { ...emptyIndex, repo: "d" }, 1);

    expect(getCachedIndex("/tmp/a.index.db", 1)?.repo).toBe("a");
    expect(getCachedIndex("/tmp/b.index.db", 1)).toBeNull();
  });

  it("re-exports backend helpers from the module that owns migration state", () => {
    expect(facadeResolveBackend).toBe(resolveIndexBackend);
    expect(facadeResetBackend).toBe(resetIndexBackendForTesting);
    expect(facadeResetMigration).toBe(resetMigrationCacheForTesting);
    expect(facadeSqlitePathFor).toBe(sqlitePathFor);
  });

  it("re-exports version helpers from the module that owns version checks", () => {
    expect(facadeCollectVersionMismatches).toBe(collectExtractorVersionMismatches);
    expect(facadeIsVersionCurrent).toBe(isExtractorVersionCurrent);
  });

  it("re-exports write counters from the module that owns mutation state", () => {
    expect(facadeWriteCount).toBe(getIndexWriteCountForTesting);
    expect(facadeResetWriteCount).toBe(resetIndexWriteCountForTesting);
  });
});
