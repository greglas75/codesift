import { describe, expect, it } from "vitest";
import {
  getIndexCacheSizeForTesting as facadeCacheSize,
  resetIndexBackendForTesting as facadeResetBackend,
  resetIndexCacheForTesting as facadeResetCache,
  resetMigrationCacheForTesting as facadeResetMigration,
  resolveIndexBackend as facadeResolveBackend,
  sqlitePathFor as facadeSqlitePathFor,
} from "../../src/storage/index-store.js";
import {
  cacheLoadedIndex,
  getIndexCacheSizeForTesting,
  resetIndexCacheForTesting,
} from "../../src/storage/index-cache.js";
import {
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resolveIndexBackend,
  sqlitePathFor,
} from "../../src/storage/index-migration.js";
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

  it("re-exports backend helpers from the module that owns migration state", () => {
    expect(facadeResolveBackend).toBe(resolveIndexBackend);
    expect(facadeResetBackend).toBe(resetIndexBackendForTesting);
    expect(facadeResetMigration).toBe(resetMigrationCacheForTesting);
    expect(facadeSqlitePathFor).toBe(sqlitePathFor);
  });
});
