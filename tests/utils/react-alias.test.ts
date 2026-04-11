import { describe, it, expect } from "vitest";
import { resolveAlias } from "../../src/utils/react-alias.js";

describe("resolveAlias — Vite/Next.js @/ heuristic", () => {
  it("resolves @/components/Foo to src/components/Foo.tsx when src exists", () => {
    const files = [{ path: "src/components/Foo.tsx" }];
    expect(resolveAlias("@/components/Foo", files)).toBe("src/components/Foo.tsx");
  });

  it("resolves to lib/ as fallback when src/ doesn't have it", () => {
    const files = [{ path: "lib/util.ts" }];
    expect(resolveAlias("@/util", files)).toBe("lib/util.ts");
  });

  it("resolves to root when neither src nor lib match", () => {
    const files = [{ path: "components/Foo.tsx" }];
    expect(resolveAlias("@/components/Foo", files)).toBe("components/Foo.tsx");
  });

  it("returns null for non-alias imports", () => {
    const files = [{ path: "src/components/Foo.tsx" }];
    expect(resolveAlias("react", files)).toBe(null);
    expect(resolveAlias("./Foo", files)).toBe(null);
    expect(resolveAlias("../utils", files)).toBe(null);
  });

  it("returns null when alias path doesn't exist in any candidate", () => {
    const files = [{ path: "src/other.ts" }];
    expect(resolveAlias("@/components/Foo", files)).toBe(null);
  });

  it("resolves index files (src/components/Foo/index.tsx)", () => {
    const files = [{ path: "src/components/Foo/index.tsx" }];
    expect(resolveAlias("@/components/Foo", files)).toBe("src/components/Foo/index.tsx");
  });

  it("prefers .tsx over .ts when both exist", () => {
    const files = [
      { path: "src/utils.tsx" },
      { path: "src/utils.ts" },
    ];
    // .tsx is checked first in TS_EXTENSIONS
    expect(resolveAlias("@/utils", files)).toBe("src/utils.tsx");
  });

  it("src/ takes precedence over lib/", () => {
    const files = [
      { path: "src/util.ts" },
      { path: "lib/util.ts" },
    ];
    expect(resolveAlias("@/util", files)).toBe("src/util.ts");
  });
});
