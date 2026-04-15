/**
 * Tests for buildResponseHint() and session-level optimization hints.
 *
 * Covers 7 fixes from usage telemetry analysis:
 *   Fix 1: get_file_tree duplicate path detection
 *   Fix 2: list_repos permanent session cache (tested via getCached behavior)
 *   Fix 3: search_symbols detail_level hint
 *   Fix 5: search_symbols + get_symbol → suggest get_context_bundle
 *   Fix 6: 3+ get_symbol → suggest assemble_context
 *   Fix 7: question-word text queries → suggest semantic search
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildResponseHint, resetSessionState, trackSequentialCalls } from "../../src/server-helpers.js";

/**
 * Simulate sequential tool calls by calling buildResponseHint for prior tools.
 * In production, trackSequentialCalls is called before buildResponseHint.
 * Since we can't call trackSequentialCalls directly (not exported), we use
 * resetSessionState + buildResponseHint's own side effects for path tracking,
 * and re-import the module to test sequential call tracking.
 *
 * For hints that depend on trackSequentialCalls state (fixes 5, 6), we
 * test via the wrapTool integration in usage-optimizations.test.ts.
 * Here we test the hint logic that buildResponseHint handles directly.
 */

beforeEach(() => {
  resetSessionState();
});

// ---------------------------------------------------------------------------
// Fix 1: get_file_tree duplicate path detection
// ---------------------------------------------------------------------------

describe("Fix 1: get_file_tree duplicate path detection", () => {
  it("should not hint on first call for a path", () => {
    const hint = buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);
    expect(hint).toBeNull();
  });

  it("should hint on second call for same repo+path", () => {
    // First call — registers path
    buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);

    // Second call — same path
    const hint = buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);
    expect(hint).not.toBeNull();
    expect(hint).toContain("H5");
    expect(hint).toContain("src");
  });

  it("should not hint for different paths in same repo", () => {
    buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);

    const hint = buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "lib" }, []);
    expect(hint).toBeNull();
  });

  it("should not hint for same path in different repos", () => {
    buildResponseHint("get_file_tree", { repo: "local/proj-a", path_prefix: "src" }, []);

    const hint = buildResponseHint("get_file_tree", { repo: "local/proj-b", path_prefix: "src" }, []);
    expect(hint).toBeNull();
  });

  it("should treat missing path_prefix as root", () => {
    buildResponseHint("get_file_tree", { repo: "local/proj" }, []);

    const hint = buildResponseHint("get_file_tree", { repo: "local/proj" }, []);
    expect(hint).not.toBeNull();
    expect(hint).toContain("H5");
  });

  it("should reset path tracking on resetSessionState", () => {
    buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);
    resetSessionState();

    const hint = buildResponseHint("get_file_tree", { repo: "local/proj", path_prefix: "src" }, []);
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 3: search_symbols detail_level hint
// ---------------------------------------------------------------------------

describe("Fix 3: search_symbols detail_level hint", () => {
  const makeSymbols = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({ id: `sym-${i}`, name: `fn${i}` }));

  it("should hint when >5 results and no detail_level", () => {
    const hint = buildResponseHint(
      "search_symbols",
      { repo: "local/proj", query: "auth" },
      makeSymbols(8),
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H6");
    expect(hint).toContain("8");
  });

  it("should not hint when detail_level is set", () => {
    const hint = buildResponseHint(
      "search_symbols",
      { repo: "local/proj", query: "auth", detail_level: "compact" },
      makeSymbols(10),
    );
    // detail_level is set, no other hint applicable → null
    expect(hint).toBeNull();
  });

  it("should not hint when <=5 results", () => {
    const hint = buildResponseHint(
      "search_symbols",
      { repo: "local/proj", query: "auth" },
      makeSymbols(3),
    );
    expect(hint).toBeNull();
  });

  it("should not hint for non-array results", () => {
    const hint = buildResponseHint(
      "search_symbols",
      { repo: "local/proj", query: "auth" },
      { symbols: [] },
    );
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 7: question-word text queries → suggest semantic search
// ---------------------------------------------------------------------------

describe("Fix 7: question-word text queries → semantic hint", () => {
  it("should hint when query starts with 'how'", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "how does auth work" },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H9");
  });

  it("should hint when query starts with 'where'", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "where is caching logic" },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H9");
  });

  it("should hint when query starts with 'why'", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "Why does this fail" },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H9");
  });

  it("should hint for 'what', 'when', 'which'", () => {
    for (const word of ["what", "when", "which"]) {
      resetSessionState();
      const hint = buildResponseHint(
        "search_text",
        { repo: "local/proj", query: `${word} module handles payments` },
        [],
      );
      expect(hint).not.toBeNull();
      expect(hint).toContain("H9");
    }
  });

  it("should not hint for keyword queries", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "validateUser" },
      [],
    );
    expect(hint).toBeNull();
  });

  it("should not hint when query is not a string", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj" },
      [],
    );
    expect(hint).toBeNull();
  });

  it("should be case-insensitive", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "HOW does auth work" },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H9");
  });

  it("should not hint when question word is mid-query", () => {
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "find how" },
      [],
    );
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 5: search_symbols + get_symbol → suggest get_context_bundle
// ---------------------------------------------------------------------------

describe("Fix 5: search_symbols + get_symbol → get_context_bundle hint", () => {
  it("should hint when get_symbol follows search_symbols", () => {
    // Simulate search_symbols call
    trackSequentialCalls("search_symbols");

    // Now get_symbol is called
    trackSequentialCalls("get_symbol");
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-1" }, {});
    expect(hint).not.toBeNull();
    expect(hint).toContain("H7");
  });

  it("should not hint on get_symbol without prior search_symbols", () => {
    trackSequentialCalls("get_symbol");
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-1" }, {});
    expect(hint).toBeNull();
  });

  it("should persist search_symbols flag across other tool calls", () => {
    trackSequentialCalls("search_symbols");
    trackSequentialCalls("get_file_outline"); // different tool in between

    trackSequentialCalls("get_symbol");
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-1" }, {});
    expect(hint).not.toBeNull();
    expect(hint).toContain("H7");
  });
});

// ---------------------------------------------------------------------------
// Fix 6: 3+ get_symbol → suggest assemble_context
// ---------------------------------------------------------------------------

describe("Fix 6: 3+ get_symbol → assemble_context hint", () => {
  it("should not hint on 1st or 2nd get_symbol", () => {
    trackSequentialCalls("get_symbol");
    const hint1 = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-1" }, {});
    expect(hint1).toBeNull();

    trackSequentialCalls("get_symbol");
    const hint2 = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-2" }, {});
    expect(hint2).toBeNull();
  });

  it("should hint on 3rd get_symbol call", () => {
    trackSequentialCalls("get_symbol");
    trackSequentialCalls("get_symbol");
    trackSequentialCalls("get_symbol");
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-3" }, {});
    expect(hint).not.toBeNull();
    expect(hint).toContain("H8");
    expect(hint).toContain("3");
  });

  it("should include count on 5th call", () => {
    for (let i = 0; i < 5; i++) {
      trackSequentialCalls("get_symbol");
    }
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-5" }, {});
    expect(hint).not.toBeNull();
    expect(hint).toContain("H8");
    expect(hint).toContain("5");
  });

  it("should reset count on resetSessionState", () => {
    trackSequentialCalls("get_symbol");
    trackSequentialCalls("get_symbol");
    trackSequentialCalls("get_symbol");
    resetSessionState();

    trackSequentialCalls("get_symbol");
    const hint = buildResponseHint("get_symbol", { repo: "local/proj", symbol_id: "sym-1" }, {});
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Existing hints: verify they still work
// ---------------------------------------------------------------------------

describe("Existing hints: search_text high cardinality", () => {
  it("should hint for >50 matches without group_by_file", () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ line: i }));
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "import" }, data);
    expect(hint).not.toBeNull();
    expect(hint).toContain("H1");
    expect(hint).toContain("60");
  });

  it("should not hint when group_by_file is already set", () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ line: i }));
    const hint = buildResponseHint(
      "search_text",
      { repo: "local/proj", query: "import", group_by_file: true },
      data,
    );
    expect(hint).toBeNull();
  });
});

describe("Existing hints: search_symbols without file_pattern", () => {
  it("should hint when include_source=true and no file_pattern", () => {
    const hint = buildResponseHint(
      "search_symbols",
      { repo: "local/proj", query: "auth", include_source: true },
      [],
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("H4");
  });
});

describe("H13 — route nudge", () => {
  beforeEach(() => resetSessionState());

  it("fires for search_text with /api/ path", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "GET /api/users" }, []);
    expect(hint).toContain("H13");
  });

  it("fires for search_text with router. pattern", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "router.get handler" }, []);
    expect(hint).toContain("H13");
  });

  it("fires for search_text with middleware", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "middleware auth" }, []);
    expect(hint).toContain("H13");
  });

  it("fires for search_text with endpoint", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "endpoint configuration" }, []);
    expect(hint).toContain("H13");
  });

  it("does NOT fire for generic search_text query", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "getUser" }, []);
    expect(hint === null || !hint.includes("H13")).toBe(true);
  });

  it("does NOT fire for non-search_text tool", () => {
    const hint = buildResponseHint("search_symbols", { repo: "local/proj", query: "GET /api/users" }, []);
    expect(hint === null || !hint.includes("H13")).toBe(true);
  });
});

describe("H14 — secrets nudge", () => {
  beforeEach(() => resetSessionState());

  it("fires for search_text with api_key", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "api_key configuration" }, []);
    expect(hint).toContain("H14");
  });

  it("fires for search_text with AWS_SECRET_ACCESS_KEY", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "AWS_SECRET_ACCESS_KEY" }, []);
    expect(hint).toContain("H14");
  });

  it("fires for search_text with OPENAI_API_KEY", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "OPENAI_API_KEY" }, []);
    expect(hint).toContain("H14");
  });

  it("fires for search_text with password", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "password validation" }, []);
    expect(hint).toContain("H14");
  });

  it("does NOT fire for normal query", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "normal search query" }, []);
    expect(hint === null || !hint.includes("H14")).toBe(true);
  });

  it("does NOT fire for 'secret santa' (bare secret excluded)", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "secret santa feature" }, []);
    // "secret" alone should NOT match — SECRET_PATTERN requires compound patterns
    // However, our regex is /api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i
    // "secret" alone does NOT match any of these patterns
    expect(hint === null || !hint.includes("H14")).toBe(true);
  });
});

describe("H9 auto-reveal semantic_search", () => {
  beforeEach(() => resetSessionState());

  it("H9 fires and does not throw from dynamic enableToolByName import", () => {
    // The dynamic import of register-tools.js inside buildResponseHint is fire-and-forget.
    // In test context, the import resolves but enableToolByName may no-op (no MCP server context).
    // This test verifies the hint is emitted without errors.
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "how does auth work" }, []);
    expect(hint).toContain("H9");
  });
});

describe("H13/H14 cross-hint isolation", () => {
  beforeEach(() => resetSessionState());

  it("question-word query triggers H9 but not H13", () => {
    const hint = buildResponseHint("search_text", { repo: "local/proj", query: "how does auth work" }, []);
    expect(hint).toContain("H9");
    expect(hint).not.toContain("H13");
  });
});
