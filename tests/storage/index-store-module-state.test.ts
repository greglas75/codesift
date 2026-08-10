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
  getIndexCacheSizeForTesting,
  resetIndexCacheForTesting,
} from "../../src/storage/index-cache.js";
import {
  resetIndexBackendForTesting,
  resetMigrationCacheForTesting,
  resolveIndexBackend,
  sqlitePathFor,
} from "../../src/storage/index-migration.js";

describe("index-store facade", () => {
  it("re-exports cache helpers from the module that owns the cache state", () => {
    expect(facadeResetCache).toBe(resetIndexCacheForTesting);
    expect(facadeCacheSize).toBe(getIndexCacheSizeForTesting);
  });

  it("re-exports backend helpers from the module that owns migration state", () => {
    expect(facadeResolveBackend).toBe(resolveIndexBackend);
    expect(facadeResetBackend).toBe(resetIndexBackendForTesting);
    expect(facadeResetMigration).toBe(resetMigrationCacheForTesting);
    expect(facadeSqlitePathFor).toBe(sqlitePathFor);
  });
});
