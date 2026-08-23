import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../../src/register-tool-groups/index.js";

const def = TOOL_DEFINITIONS.find((t) => t.name === "list_repos");

/**
 * The registry holds two namespaces and only one of them is code. Measured on a real registry:
 * 418 of 590 entries were `conversations/*`, carrying 86% of the response bytes — 11,150 tokens
 * where the code repos were ~550. An agent asking which repos it can search paid for the answer
 * to a different question.
 */
describe("list_repos namespaces", () => {
  it("is registered with the include_conversations switch", () => {
    expect(def).toBeDefined();
    const schema = typeof def!.schema === "function" ? (def!.schema as () => unknown)() : def!.schema;
    expect(Object.keys(schema as object)).toContain("include_conversations");
  });

  it("says in its description that conversation indexes are excluded", () => {
    expect(def!.description).toMatch(/conversation/i);
  });

  // The point of the switch is that it is OFF unless asked for. A default of "include" would
  // reintroduce the exact cost this exists to remove, while still passing the schema test above.
  it("documents the default as exclusion, not inclusion", () => {
    const schema = typeof def!.schema === "function" ? (def!.schema as () => Record<string, unknown>)() : def!.schema;
    const field = (schema as Record<string, { description?: string; _def?: { description?: string } }>)["include_conversations"];
    const text = field?.description ?? field?._def?.description ?? "";
    expect(String(text)).toMatch(/default false/i);
  });
});
