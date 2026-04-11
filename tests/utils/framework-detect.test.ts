import { describe, it, expect } from "vitest";
import { detectFrameworks, isFrameworkEntryPoint } from "../../src/utils/framework-detect.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

function makeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test",
    symbols: [],
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

function makeFile(path: string): FileEntry {
  return { path, language: "astro", symbol_count: 0, last_modified: 0 };
}

describe("detectFrameworks — Astro", () => {
  it("returns 'astro' when a symbol source imports from 'astro' (dependencies signal)", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "MyLayout",
          kind: "function",
          file: "src/layouts/Layout.astro",
          start_line: 1,
          end_line: 10,
          source: "import { Code } from 'astro:components';",
        },
      ],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });

  it("returns 'astro' when a symbol source imports from \"astro\" (devDependencies signal)", () => {
    const index = makeIndex({
      symbols: [
        {
          name: "MyComponent",
          kind: "function",
          file: "src/components/Card.astro",
          start_line: 1,
          end_line: 5,
          source: 'import type { ImageMetadata } from "astro";',
        },
      ],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });

  it("returns 'astro' when any file has .astro extension", () => {
    const index = makeIndex({
      files: [makeFile("src/pages/index.astro")],
    });
    const result = detectFrameworks(index);
    expect(result.has("astro")).toBe(true);
  });
});

describe("isFrameworkEntryPoint — Astro", () => {
  const astroFrameworks = new Set<import("../../src/utils/framework-detect.js").Framework>(["astro", "test"]);

  it("returns true for .astro files in src/pages/", () => {
    expect(
      isFrameworkEntryPoint({ name: "default", file: "src/pages/index.astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for .ts route files in src/pages/", () => {
    expect(
      isFrameworkEntryPoint({ name: "GET", file: "src/pages/api/users.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for getStaticPaths symbol", () => {
    expect(
      isFrameworkEntryPoint({ name: "getStaticPaths", file: "src/pages/blog/[slug].astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for prerender symbol", () => {
    expect(
      isFrameworkEntryPoint({ name: "prerender", file: "src/pages/about.astro" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for GET symbol in an Astro project", () => {
    expect(
      isFrameworkEntryPoint({ name: "GET", file: "src/pages/api/data.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns true for POST symbol in an Astro project", () => {
    expect(
      isFrameworkEntryPoint({ name: "POST", file: "src/pages/api/data.ts" }, astroFrameworks),
    ).toBe(true);
  });

  it("returns false for non-pages file with arbitrary name", () => {
    expect(
      isFrameworkEntryPoint({ name: "helperFn", file: "src/lib/utils.ts" }, astroFrameworks),
    ).toBe(false);
  });
});
