import { describe, it, expect } from "vitest";
import { traceRoute, matchPath } from "../../src/tools/route-tools.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CodeIndex without hitting disk or a real repo. */
function makeIndex(
  files: Array<{ path: string; language?: string }>,
  symbols: Partial<CodeSymbol>[] = [],
): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    files: files.map((f) => ({
      path: f.path,
      language: f.language ?? "typescript",
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

// Patch getCodeIndex so traceRoute uses our fixture index without a real repo.
import * as indexTools from "../../src/tools/index-tools.js";
import { vi } from "vitest";

function withIndex(index: CodeIndex, fn: () => Promise<void>): Promise<void> {
  const spy = vi.spyOn(indexTools, "getCodeIndex").mockResolvedValue(index);
  return fn().finally(() => spy.mockRestore());
}

// ---------------------------------------------------------------------------
// matchPath (pure, no I/O)
// ---------------------------------------------------------------------------

describe("matchPath", () => {
  it("matches static paths", () => {
    expect(matchPath("/blog/hello", "/blog/hello")).toBe(true);
  });

  it("matches dynamic :param segment", () => {
    expect(matchPath("/blog/:slug", "/blog/hello")).toBe(true);
  });

  it("matches Next.js [param] segment", () => {
    expect(matchPath("/blog/[slug]", "/blog/hello")).toBe(true);
  });

  it("does not match different segment counts", () => {
    expect(matchPath("/a/b", "/a")).toBe(false);
  });

  it("does not match different static segments", () => {
    expect(matchPath("/blog/hello", "/blog/world")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// traceRoute — Astro dispatch (Task 15)
// ---------------------------------------------------------------------------

describe("traceRoute — Astro", () => {
  it("resolves /blog/hello to handler with framework astro", async () => {
    const index = makeIndex(
      [{ path: "src/pages/blog/[slug].astro", language: "astro" }],
      [
        {
          name: "getStaticPaths",
          file: "src/pages/blog/[slug].astro",
          kind: "function",
          start_line: 2,
          end_line: 5,
        },
        {
          name: "default",
          file: "src/pages/blog/[slug].astro",
          kind: "function",
          start_line: 7,
          end_line: 20,
        },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/blog/hello");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers.length).toBeGreaterThan(0);
      expect(result.handlers[0]!.framework).toBe("astro");
      expect(result.handlers[0]!.file).toBe("src/pages/blog/[slug].astro");
    });
  });

  it("resolves /api/data to endpoint handler with framework astro", async () => {
    const index = makeIndex(
      [{ path: "src/pages/api/data.ts", language: "typescript" }],
      [
        {
          name: "GET",
          file: "src/pages/api/data.ts",
          kind: "function",
          start_line: 1,
          end_line: 5,
        },
      ],
    );

    await withIndex(index, async () => {
      const result = await traceRoute("test", "/api/data");
      if ("mermaid" in result) throw new Error("Expected RouteTraceResult, got mermaid");
      expect(result.handlers.length).toBeGreaterThan(0);
      const handler = result.handlers[0]!;
      expect(handler.framework).toBe("astro");
      expect(handler.file).toBe("src/pages/api/data.ts");
      expect(handler.method).toBe("GET");
    });
  });
});
