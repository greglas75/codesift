import { describe, it, expect } from "vitest";
import { findAstroHandlers, buildRouteEntries, fileToRoute } from "../../src/tools/astro-routes.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

/** Build a minimal CodeIndex with the given files and symbols. */
function makeIndex(
  files: Array<{ path: string; language?: string }>,
  symbols: Partial<CodeSymbol>[] = [],
): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    files: files.map((f) => ({
      path: f.path,
      language: f.language ?? "astro",
      symbol_count: 0,
      last_modified: Date.now(),
    })) as FileEntry[],
    symbols: symbols.map((s, i) => ({
      id: s.id ?? `test:${s.file}:${s.name}:${s.start_line ?? i}`,
      repo: "test",
      name: s.name ?? "unknown",
      kind: s.kind ?? "function",
      file: s.file ?? "",
      start_line: s.start_line ?? 1,
      end_line: s.end_line ?? 1,
      ...s,
    })) as CodeSymbol[],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: files.length,
  };
}

describe("fileToRoute", () => {
  it("converts a static page path", () => {
    expect(fileToRoute("src/pages/about.astro")).toBe("/about");
  });

  it("converts index to root", () => {
    expect(fileToRoute("src/pages/index.astro")).toBe("/");
  });

  it("converts dynamic segment", () => {
    expect(fileToRoute("src/pages/blog/[slug].astro")).toBe("/blog/:slug");
  });

  it("converts rest segment", () => {
    expect(fileToRoute("src/pages/docs/[...path].astro")).toBe("/docs/*path");
  });
});

describe("buildRouteEntries", () => {
  it("1: static route — about.astro → /about, type page, rendering static", () => {
    const index = makeIndex(
      [{ path: "src/pages/about.astro" }],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/about",
      type: "page",
      rendering: "static",
      file: "src/pages/about.astro",
    });
  });

  it("2: dynamic route — blog/[slug].astro → /blog/:slug with dynamic_params", () => {
    const index = makeIndex(
      [{ path: "src/pages/blog/[slug].astro" }],
      [{ name: "getStaticPaths", file: "src/pages/blog/[slug].astro", kind: "function" }],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/blog/:slug",
      dynamic_params: ["slug"],
      has_getStaticPaths: true,
    });
  });

  it("3: rest route — docs/[...path].astro → /docs/*path", () => {
    const index = makeIndex(
      [{ path: "src/pages/docs/[...path].astro" }],
      [{ name: "getStaticPaths", file: "src/pages/docs/[...path].astro", kind: "function" }],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/docs/*path",
      dynamic_params: ["path"],
    });
  });

  it("4: API endpoint .ts with GET → type endpoint, methods [GET]", () => {
    const index = makeIndex(
      [{ path: "src/pages/api/data.ts", language: "typescript" }],
      [{ name: "GET", file: "src/pages/api/data.ts", kind: "function" }],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/api/data",
      type: "endpoint",
      methods: ["GET"],
    });
  });

  it("5: endpoint with multiple methods → methods [GET, POST]", () => {
    const index = makeIndex(
      [{ path: "src/pages/api/users.ts", language: "typescript" }],
      [
        { name: "GET", file: "src/pages/api/users.ts", kind: "function" },
        { name: "POST", file: "src/pages/api/users.ts", kind: "function" },
      ],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.methods).toEqual(["GET", "POST"]);
  });

  it("6: missing getStaticPaths warning for dynamic .astro route", () => {
    const index = makeIndex(
      [{ path: "src/pages/blog/[slug].astro" }],
      // No getStaticPaths symbol
    );
    const { routes, warnings } = buildRouteEntries(index);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.rendering).toBe("server");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("getStaticPaths");
  });

  it("7: route conflict detection — [slug] and [...rest] overlap", () => {
    const index = makeIndex(
      [
        { path: "src/pages/blog/[slug].astro" },
        { path: "src/pages/blog/[...rest].astro" },
      ],
      [
        { name: "getStaticPaths", file: "src/pages/blog/[slug].astro", kind: "function" },
        { name: "getStaticPaths", file: "src/pages/blog/[...rest].astro", kind: "function" },
      ],
    );
    const { warnings } = buildRouteEntries(index);
    expect(warnings.some((w) => w.includes("conflict"))).toBe(true);
  });

  it("8: route ordering — static before dynamic before rest", () => {
    const index = makeIndex(
      [
        { path: "src/pages/blog/[...rest].astro" },
        { path: "src/pages/blog/[slug].astro" },
        { path: "src/pages/blog/featured.astro" },
      ],
      [
        { name: "getStaticPaths", file: "src/pages/blog/[slug].astro", kind: "function" },
        { name: "getStaticPaths", file: "src/pages/blog/[...rest].astro", kind: "function" },
      ],
    );
    const { routes } = buildRouteEntries(index);
    expect(routes[0]!.path).toBe("/blog/featured"); // static
    expect(routes[1]!.path).toBe("/blog/:slug");     // dynamic
    expect(routes[2]!.path).toBe("/blog/*rest");      // rest
  });

  it("9: empty src/pages/ → routes [], summary total_routes 0", () => {
    const index = makeIndex([
      { path: "src/components/Header.astro" }, // Not under pages
    ]);
    const { routes } = buildRouteEntries(index);
    expect(routes).toEqual([]);
  });
});

describe("findAstroHandlers", () => {
  it("10: matches handler for /blog/hello with framework astro", () => {
    const index = makeIndex(
      [{ path: "src/pages/blog/[slug].astro" }],
      [
        { name: "getStaticPaths", file: "src/pages/blog/[slug].astro", kind: "function" },
        { name: "default", file: "src/pages/blog/[slug].astro", kind: "default_export", start_line: 5 },
      ],
    );
    const handlers = findAstroHandlers(index, "/blog/hello");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.framework).toBe("astro");
    expect(handlers[0]!.file).toBe("src/pages/blog/[slug].astro");
  });
});
