import { describe, it, expect } from "vitest";
import {
  resolveImportPath,
  buildNormalizedPathMap,
} from "../../src/utils/import-graph.js";
import type { CodeIndex } from "../../src/types.js";

const makeIndex = (paths: string[]): CodeIndex => ({
  repo: "test",
  root: "/tmp/test",
  files: paths.map((path) => ({
    path,
    language: "astro",
    symbol_count: 0,
    last_modified: 0,
    mtime_ms: 0,
  })),
  symbols: [],
});

describe("resolveImportPath — .astro extension", () => {
  it("strips .astro extension when resolving a relative import", () => {
    const importer = "src/pages/index.astro";
    const importPath = "./Card.astro";
    const resolved = resolveImportPath(importer, importPath);
    expect(resolved).toBe("src/pages/Card");
  });

  it("idempotency: normalizing an already-normalized .astro path is stable", () => {
    const importer = "src/pages/index.astro";
    const importPath = "./Card.astro";
    const once = resolveImportPath(importer, importPath);
    // Simulate re-normalizing by passing the resolved path through again
    // (path has no extension left, so second pass should be a no-op)
    const twice = once.replace(/\.(astro|ts|tsx|js|jsx|mjs|cjs|php)$/, "");
    expect(twice).toBe(once);
  });

  it("does NOT over-strip: Card.astro becomes Card, not Card.astr or Card.ast", () => {
    const importer = "src/layouts/Base.astro";
    const importPath = "./Header.astro";
    const resolved = resolveImportPath(importer, importPath);
    expect(resolved).toBe("src/layouts/Header");
    expect(resolved).not.toContain(".astro");
    expect(resolved).not.toContain(".astr");
    expect(resolved).not.toContain(".ast");
  });

  it("resolves ../ traversal correctly for .astro imports", () => {
    const importer = "src/pages/blog/Post.astro";
    const importPath = "../components/Nav.astro";
    const resolved = resolveImportPath(importer, importPath);
    expect(resolved).toBe("src/pages/components/Nav");
  });
});

describe("buildNormalizedPathMap — .astro files", () => {
  it("includes .astro files in the normalized path map", () => {
    const index = makeIndex([
      "src/components/Card.astro",
      "src/pages/index.astro",
      "src/layouts/Base.astro",
    ]);
    const map = buildNormalizedPathMap(index);

    expect(map.get("src/components/Card")).toBe("src/components/Card.astro");
    expect(map.get("src/pages/index")).toBe("src/pages/index.astro");
    expect(map.get("src/layouts/Base")).toBe("src/layouts/Base.astro");
  });

  it("does not map .astro files under wrong keys", () => {
    const index = makeIndex(["src/components/Button.astro"]);
    const map = buildNormalizedPathMap(index);

    // Raw path with extension should NOT be a key (we strip it)
    expect(map.has("src/components/Button.astro")).toBe(false);
    // Correct stripped key should be present
    expect(map.has("src/components/Button")).toBe(true);
  });
});
