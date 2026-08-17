// Verified findings from the 2026-08-10 adversarial review, confirmed against the code on
// 2026-08-16 and fixed here. Each test names the specific wrong behaviour rather than the shape of
// the patch, because the patch is small and the reason is the part worth keeping.
import { describe, it, expect } from "vitest";
import type { CodeIndex } from "../../src/types.js";
import { findNextJSHandlers } from "../../src/tools/route-tools/next.js";

function indexWith(files: string[], symbols: Array<{ name: string; file: string }>): CodeIndex {
  return {
    repo: "local/t",
    root: "/repo",
    files: files.map((path) => ({ path, language: "typescript", symbol_count: 0, last_modified: 0 })),
    symbols: symbols.map((s, i) => ({
      id: `local/t:${s.file}:${s.name}:${i}`,
      name: s.name,
      kind: "function",
      file: s.file,
      start_line: i + 1,
      end_line: i + 2,
    })),
  } as unknown as CodeIndex;
}

describe("Next.js route discovery", () => {
  it("finds a root App Router route at app/route.ts", () => {
    // `/app\/(.*?)\/route\./` demanded a segment between `app/` and the file, so the route for `/`
    // — an ordinary Next.js route — was unreachable by construction.
    const index = indexWith(["app/route.ts"], [{ name: "GET", file: "app/route.ts" }]);
    const handlers = findNextJSHandlers(index, "/");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.method).toBe("GET");
  });

  it("still resolves a nested route", () => {
    const index = indexWith(["app/users/route.ts"], [{ name: "GET", file: "app/users/route.ts" }]);
    expect(findNextJSHandlers(index, "/users")).toHaveLength(1);
  });

  it.each(["HEAD", "OPTIONS"])("discovers a %s export as a method", (method) => {
    // Omitting these did not merely lose the method name: a file exporting only HEAD fell into the
    // "no handlers found" branch and was reported as an un-methoded synthetic route.
    const index = indexWith(["app/ping/route.ts"], [{ name: method, file: "app/ping/route.ts" }]);
    const handlers = findNextJSHandlers(index, "/ping");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.method).toBe(method);
    expect(handlers[0]?.symbol.name).toBe(method);
  });

  it("does not treat an unrelated export as a route method", () => {
    // The regex is an allowlist for a reason — widening it to "any uppercase export" would make
    // constants into handlers.
    const index = indexWith(["app/x/route.ts"], [{ name: "REVALIDATE", file: "app/x/route.ts" }]);
    const handlers = findNextJSHandlers(index, "/x");
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.method).toBeUndefined();   // synthetic, no method claimed
  });
});
