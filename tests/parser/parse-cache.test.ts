import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
  getCachedParse,
  setCachedParse,
  resetParseCache,
  getParseCacheStats,
} from "../../src/parser/parse-cache.js";
import { initParser, getParser } from "../../src/parser/parser-manager.js";

beforeAll(async () => {
  await initParser();
});

describe("parse-cache", () => {
  beforeEach(() => { resetParseCache(); });

  it("returns null on cache miss", () => {
    const result = getCachedParse("python", "def foo(): pass");
    expect(result).toBeNull();
    expect(getParseCacheStats().misses).toBe(1);
  });

  it("stores and retrieves a parse tree", async () => {
    const parser = await getParser("python");
    expect(parser).not.toBeNull();

    const source = "def foo(): pass";
    const tree = parser!.parse(source);

    setCachedParse("python", source, tree);
    const retrieved = getCachedParse("python", source);

    expect(retrieved).toBe(tree);
    expect(getParseCacheStats().hits).toBe(1);
  });

  it("produces different keys for different languages", async () => {
    const parser = await getParser("python");
    const source = "x = 1";
    const tree = parser!.parse(source);

    setCachedParse("python", source, tree);
    // Same source, different language → cache miss
    expect(getCachedParse("typescript", source)).toBeNull();
    // Same source, same language → cache hit
    expect(getCachedParse("python", source)).toBe(tree);
  });

  it("produces different keys for different source", async () => {
    const parser = await getParser("python");
    const source1 = "def foo(): pass";
    const source2 = "def bar(): pass";
    const tree1 = parser!.parse(source1);
    const tree2 = parser!.parse(source2);

    setCachedParse("python", source1, tree1);
    setCachedParse("python", source2, tree2);

    expect(getCachedParse("python", source1)).toBe(tree1);
    expect(getCachedParse("python", source2)).toBe(tree2);
  });

  it("updates hit_rate correctly", async () => {
    const parser = await getParser("python");
    const tree = parser!.parse("x = 1");

    setCachedParse("python", "x = 1", tree);
    getCachedParse("python", "x = 1"); // hit
    getCachedParse("python", "x = 1"); // hit
    getCachedParse("python", "y = 2"); // miss

    const stats = getParseCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hit_rate).toBeCloseTo(2 / 3, 2);
  });

  it("does not duplicate entries on repeated set with same key", async () => {
    const parser = await getParser("python");
    const tree = parser!.parse("z = 1");

    setCachedParse("python", "z = 1", tree);
    setCachedParse("python", "z = 1", tree);
    setCachedParse("python", "z = 1", tree);

    expect(getParseCacheStats().size).toBe(1);
  });

  it("resetParseCache clears all entries and stats", async () => {
    const parser = await getParser("python");
    const tree = parser!.parse("a = 1");

    setCachedParse("python", "a = 1", tree);
    getCachedParse("python", "a = 1");

    resetParseCache();
    const stats = getParseCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});
