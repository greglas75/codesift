import { describe, it, expect, vi, beforeEach } from "vitest";

// The tool reads the summary and pages through symbols; both are derived from the one
// getCodeIndex fixture so the test asserts on the tool, not on which accessor is stubbed.
vi.mock("../../src/tools/index-tools.js", async () => {
  const { withDerivedIndexAccessors } = await import("../helpers/index-accessors-from-fixture.js");
  return withDerivedIndexAccessors({ getCodeIndex: vi.fn() });
});

import { analyzeRenders } from "../../src/tools/react-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

function baseIndex(overrides: Partial<CodeIndex>): CodeIndex {
  return {
    repo: "r",
    root: "/r",
    symbols: [],
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

function funcSym(
  overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "file" | "name" | "id">,
): CodeSymbol {
  return {
    repo: "r",
    kind: "function",
    start_line: 1,
    end_line: 5,
    source: "export function x() {}",
    ...overrides,
  };
}

describe("analyzeRenders — extractor-failure metadata (Tier 5 fix)", () => {
  beforeEach(() => {
    vi.mocked(getCodeIndex).mockReset();
  });

  it("does not set metadata when only .ts files exist (utils-only index)", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(
      baseIndex({
        symbols: [funcSym({ id: "u1", name: "Util", file: "util.ts" })],
        files: [
          {
            path: "util.ts",
            language: "typescript",
            symbol_count: 1,
            last_modified: 0,
          },
        ],
        symbol_count: 1,
        file_count: 1,
      }),
    );
    const result = await analyzeRenders("repo");
    if (typeof result === "string") throw new Error("expected JSON result");
    expect(result.metadata).toBeUndefined();
  });

  it("sets metadata.skipped when indexed .tsx has symbols but no component symbols", async () => {
    vi.mocked(getCodeIndex).mockResolvedValue(
      baseIndex({
        symbols: [funcSym({ id: "u1", name: "Util", file: "App.tsx" })],
        files: [
          {
            path: "App.tsx",
            language: "tsx",
            symbol_count: 1,
            last_modified: 0,
          },
        ],
        symbol_count: 1,
        file_count: 1,
      }),
    );
    const result = await analyzeRenders("repo");
    if (typeof result === "string") throw new Error("expected JSON result");
    expect(result.metadata).toEqual({ skipped: "extractor-failure" });
  });
});
