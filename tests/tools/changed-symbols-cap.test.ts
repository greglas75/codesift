import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/register-tool-groups/index.js";

const def = TOOL_DEFINITIONS.find((t) => t.name === "changed_symbols");

/**
 * The per-file diff was capped at 500 chars while the number of FILES was not capped at all.
 * Telemetry across 592 calls: a 308-token median against a 71,854-token maximum — on a wide enough
 * range the answer exceeds any context window, which is not a useful answer at any size.
 */
describe("changed_symbols output cap", () => {
  it("exposes max_files", () => {
    expect(def).toBeDefined();
    const schema = typeof def!.schema === "function" ? (def!.schema as () => object)() : def!.schema;
    expect(Object.keys(schema as object)).toContain("max_files");
  });

  // Truncation that does not announce itself turns "these are the changed files" into a false
  // statement. Every other cap in this codebase reports its overflow; this one must too.
  it("promises to report the overflow rather than truncate silently", () => {
    const schema = typeof def!.schema === "function" ? (def!.schema as () => Record<string, { description?: string; _def?: { description?: string } }>)() : def!.schema;
    const field = (schema as Record<string, { description?: string; _def?: { description?: string } }>)["max_files"];
    const text = String(field?.description ?? field?._def?.description ?? "");
    expect(text).toMatch(/overflow/i);
  });

  // Files, not symbols: one file's symbols belong together, and cutting mid-file would present a
  // partial view of a file while claiming to list its changed symbols.
  it("caps by file, which is the unit the answer is about", () => {
    const schema = typeof def!.schema === "function" ? (def!.schema as () => Record<string, { description?: string; _def?: { description?: string } }>)() : def!.schema;
    const text = String(schema["max_files"]?.description ?? schema["max_files"]?._def?.description ?? "");
    expect(text).toMatch(/FILES/);
  });
});
