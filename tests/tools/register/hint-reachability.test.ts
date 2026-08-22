import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildResponseHint,
  resetHintState,
  setHintToolVisibility,
  trackSequentialCalls,
} from "../../../src/server-helpers/response-hints.js";

const CATALOG = new Set(["search_text", "search_symbols", "codebase_retrieval", "get_context_bundle"]);

/**
 * Drive the H2 path and return every hint emitted along the way.
 *
 * H2 fires ONCE, exactly when the consecutive count hits the threshold — reading only the last
 * call's hint misses it. The result is also non-empty on purpose: an empty one triggers the
 * zero-match hint instead, which would mask what this file is testing.
 */
function repeatedCalls(tool: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    trackSequentialCalls(tool);
    const h = buildResponseHint(tool, { query: "x", file_pattern: "*.ts" }, [{ file: "a.ts", line: 1 }]);
    if (h) out.push(h);
  }
  return out.join(" ");
}

beforeEach(() => resetHintState());
afterEach(() => {
  resetHintState();
  setHintToolVisibility(null, null); // back to "nobody told us" — the pre-injection state
});

describe("hint reachability", () => {
  it("keeps a hint whose named tool is registered", () => {
    setHintToolVisibility(CATALOG, new Set(["search_text", "codebase_retrieval"]));
    const hint = repeatedCalls("search_text", 4);
    expect(hint).toContain("codebase_retrieval");
  });

  it("drops a hint naming a tool this process did not register", () => {
    setHintToolVisibility(CATALOG, new Set(["search_text"]));
    const hint = repeatedCalls("search_text", 4);
    expect(hint).not.toContain("codebase_retrieval");
  });

  // The first version matched only `name(`, so a tool named after a comma — the exact shape of
  // `H2(3,codebase_retrieval)` — slipped through while the same tool was filtered out of the next
  // hint. Suppressed in one place and advertised in another is worse than either alone.
  it("matches a bare tool name, not only the call form", () => {
    setHintToolVisibility(CATALOG, new Set(["search_text"]));
    const hint = repeatedCalls("search_text", 4);
    expect(hint).not.toMatch(/codebase_retrieval/);
  });

  // Never having been told is different from having been told "nothing is callable". A caller that
  // does not wire this up must keep every hint it used to get.
  it("filters nothing until visibility is injected", () => {
    const hint = repeatedCalls("search_text", 4);
    expect(hint).toContain("codebase_retrieval");
  });

  it("leaves hints that name no catalog tool alone", () => {
    setHintToolVisibility(CATALOG, new Set());
    const hint = buildResponseHint("search_symbols", { include_source: true }, []);
    // H4 (include_source without file_pattern) names no tool — it must survive an empty surface.
    expect(hint ?? "").toContain("H4");
  });
});
