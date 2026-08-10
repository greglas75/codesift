import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as parserManager from "../../src/parser/parser-manager.js";
import { resolveTypeScriptConstantValue } from "../../src/tools/typescript-constants-tools.js";
import {
  createConstantResolutionFixture,
  type ConstantResolutionFixture,
} from "./helpers/constant-resolution-fixture.js";

let fixture: ConstantResolutionFixture;

beforeEach(async () => {
  fixture = await createConstantResolutionFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

describe("resolveTypeScriptConstantValue — edge cases", () => {
  it("throws a specific error when the repository does not exist", async () => {
    await expect(resolveTypeScriptConstantValue("missing-repository", "VALUE")).rejects.toThrow(
      'Repository "missing-repository" not found.',
    );
  });

  it("throws a specific error when the TypeScript parser is unavailable", async () => {
    const repo = await fixture.write({
      "src/constants.ts": "export const VALUE = 1\n",
    });
    vi.spyOn(parserManager, "getParser").mockResolvedValueOnce(null);

    await expect(resolveTypeScriptConstantValue(repo, "VALUE")).rejects.toThrow(
      "TypeScript parser unavailable",
    );
  });

  it("resolves supported literal families with exact values", async () => {
    const repo = await fixture.write({
      "src/literals.ts": `export const EMPTY_TEMPLATE = \`\`
export const FLOAT = 1.5
export const EXPONENT = 1e3
export const TRUE_VALUE = true
export const FALSE_VALUE = false
export const NULL_VALUE = null
export const LIST_VALUE = ["a", 2, false, null]
export const OBJECT_VALUE = { "api": "https://api.example.com", retries: 3, enabled: true, none: null }
export const PARENTHESIZED = (3)
export const NEGATIVE = -5
export const POSITIVE = +5
`,
    });
    const expected = new Map<string, unknown>([
      ["EMPTY_TEMPLATE", ""],
      ["FLOAT", 1.5],
      ["EXPONENT", 1000],
      ["TRUE_VALUE", true],
      ["FALSE_VALUE", false],
      ["NULL_VALUE", null],
      ["LIST_VALUE", ["a", 2, false, null]],
      ["OBJECT_VALUE", { api: "https://api.example.com", retries: 3, enabled: true, none: null }],
      ["PARENTHESIZED", 3],
      ["NEGATIVE", -5],
      ["POSITIVE", 5],
    ]);

    for (const [name, value] of expected) {
      const result = await resolveTypeScriptConstantValue(repo, name);
      expect(result.matches[0]).toMatchObject({ resolved: true, value });
    }
  });

  it("returns exact reasons for unsupported and unsafe values", async () => {
    const repo = await fixture.write({
      "src/unsupported.ts": `declare const name: string
export const STATIC_TEMPLATE = \`hello\`
export const DYNAMIC_TEMPLATE = \`hello \${name}\`
export const UNSAFE_INTEGER = 9007199254740992
export const CALL_VALUE = other()
`,
    });
    const expectedReasons = new Map([
      ["STATIC_TEMPLATE", "Unsupported TypeScript value node: template_string"],
      ["DYNAMIC_TEMPLATE", "Unsupported TypeScript value node: template_string"],
      ["UNSAFE_INTEGER", "Integer literal outside safe Number range"],
      ["CALL_VALUE", "Unsupported TypeScript value node: call_expression"],
    ]);

    for (const [name, reason] of expectedReasons) {
      const result = await resolveTypeScriptConstantValue(repo, name);
      expect(result.matches[0]).toMatchObject({ resolved: false, reason });
    }
  });

  it("reports missing properties, bindings, and dynamic keys precisely", async () => {
    const repo = await fixture.write({
      "src/missing.ts": `declare function getKey(): string
export const CONFIG = { api: "https://api.example.com" }
export const MISSING_PROPERTY = CONFIG.missing
export const MISSING_BINDING = UNKNOWN_VALUE
export const DYNAMIC_KEY = CONFIG[getKey()]
`,
    });

    const missingProperty = await resolveTypeScriptConstantValue(repo, "MISSING_PROPERTY");
    const missingBinding = await resolveTypeScriptConstantValue(repo, "MISSING_BINDING");
    const dynamicKey = await resolveTypeScriptConstantValue(repo, "DYNAMIC_KEY");

    expect(missingProperty.matches[0]).toMatchObject({
      resolved: false,
      reason: "Property missing not found on resolved object",
    });
    expect(missingBinding.matches[0]).toMatchObject({
      resolved: false,
      reason: "No resolvable binding found for UNKNOWN_VALUE in src/missing.ts",
    });
    expect(dynamicKey.matches[0]).toMatchObject({
      resolved: false,
      reason: "Unsupported TypeScript value node: subscript_expression",
    });
  });

  it("resolves literal default exports through a default import", async () => {
    const repo = await fixture.write({
      "src/base.ts": "export default [\"a\", 2]\n",
      "src/consumer.ts": `import defaults from "./base"
export const DEFAULTS = defaults
`,
    });

    const result = await resolveTypeScriptConstantValue(repo, "DEFAULTS");

    expect(result.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "list",
      value: ["a", 2],
    });
  });

  it("returns explicit outcomes for cycles, unresolved list entries, and functions without defaults", async () => {
    const repo = await fixture.write({
      "src/edge.ts": `export const A = B
export const B = A
export const BAD_LIST = [UNKNOWN]
export function noDefaults(value: string) { return value }
`,
    });

    const cycle = await resolveTypeScriptConstantValue(repo, "A");
    const badList = await resolveTypeScriptConstantValue(repo, "BAD_LIST");
    const noDefaults = await resolveTypeScriptConstantValue(repo, "noDefaults");

    expect(cycle.matches[0]).toMatchObject({ resolved: false, reason: "Cycle detected while resolving A" });
    expect(badList.matches[0]).toMatchObject({
      resolved: false,
      reason: "No resolvable binding found for UNKNOWN in src/edge.ts",
    });
    expect(noDefaults.matches[0]).toMatchObject({
      resolved: false,
      default_parameters: [],
      reason: "Function has no default parameters",
    });
  });

  it("filters candidates by file pattern and returns multiple matches in stable file order", async () => {
    const repo = await fixture.write({
      "src/a.ts": "export const DUPLICATE = 1\n",
      "src/b.ts": "export const DUPLICATE = 2\n",
    });

    const all = await resolveTypeScriptConstantValue(repo, "DUPLICATE");
    const filtered = await resolveTypeScriptConstantValue(repo, "DUPLICATE", { file_pattern: "src/b.ts" });
    const absent = await resolveTypeScriptConstantValue(repo, "MISSING");

    expect(all.matches.map(({ file, value }) => [file, value])).toEqual([
      ["src/a.ts", 1],
      ["src/b.ts", 2],
    ]);
    expect(filtered.matches).toEqual([
      expect.objectContaining({ file: "src/b.ts", value: 2 }),
    ]);
    expect(absent.matches).toEqual([]);
  });
});
