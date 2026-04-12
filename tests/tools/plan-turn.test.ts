import { describe, it, expect, vi } from "vitest";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { parseQuery } from "../../src/tools/plan-turn-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSym(name: string, file = "src/auth.ts"): CodeSymbol {
  return {
    id: `test:${file}:${name}:1`,
    repo: "test",
    name,
    kind: "function",
    file,
    start_line: 1,
    end_line: 10,
  };
}

function makeIndex(symbols: CodeSymbol[] = []): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: symbols.length,
    file_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
  it("1. basic query → single intent, non-vague", () => {
    const index = makeIndex();
    const result = parseQuery("find all unused exports in the project", index);

    expect(result.original).toBe("find all unused exports in the project");
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toBe("find all unused exports in the project");
    expect(result.is_vague).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("2. multi-intent 'audit deps AND refactor auth' → 2 intents", () => {
    const index = makeIndex();
    const result = parseQuery("audit deps AND refactor auth", index);

    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toBe("audit deps");
    expect(result.intents[1]).toBe("refactor auth");
  });

  it("3. file ref 'review src/auth.ts' → file_refs populated", () => {
    const index = makeIndex();
    const result = parseQuery("review src/auth.ts for security issues", index);

    expect(result.file_refs).toContain("src/auth.ts");
  });

  it("4. symbol ref 'trace createUser' → symbol_refs populated", () => {
    const index = makeIndex([makeSym("createUser")]);
    const result = parseQuery("trace createUser across all modules", index);

    expect(result.symbol_refs).toContain("createUser");
  });

  it("5. vague 'help' → is_vague: true", () => {
    const index = makeIndex();
    const result = parseQuery("help", index);

    expect(result.is_vague).toBe(true);
  });

  it("6. truncation: 2000-char input → truncated: true, normalized length 1000", () => {
    const index = makeIndex();
    const longInput = "a".repeat(2000);
    const result = parseQuery(longInput, index);

    expect(result.truncated).toBe(true);
    expect(result.normalized.length).toBe(1000);
    expect(result.original.length).toBe(2000);
  });

  it("7. empty string → empty intents, is_vague: true", () => {
    const index = makeIndex();
    const result = parseQuery("", index);

    expect(result.intents).toHaveLength(0);
    expect(result.file_refs).toHaveLength(0);
    expect(result.symbol_refs).toHaveLength(0);
    expect(result.is_vague).toBe(true);
  });

  it("8. regex safety: 'handleANDGate' → NO split (still 1 intent)", () => {
    const index = makeIndex();
    const result = parseQuery("analyze handleANDGate behavior", index);

    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toBe("analyze handleandgate behavior");
  });
});
