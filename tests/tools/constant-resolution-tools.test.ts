import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CodeSymbol } from "../../src/types.js";
import { getParser } from "../../src/parser/parser-manager.js";
import { resolveConstantValue } from "../../src/tools/constant-resolution-tools.js";
import { resolveTypeScriptConstantValue } from "../../src/tools/typescript-constants-tools.js";
import { disposeTypeScriptFileContexts } from "../../src/tools/typescript-constants/file-context.js";
import { resolveFunctionDefaults } from "../../src/tools/typescript-constants/symbol-resolver.js";
import type {
  ResolutionState,
  TypeScriptFileContext,
} from "../../src/tools/typescript-constants/types.js";
import {
  createConstantResolutionFixture,
  type ConstantResolutionFixture,
} from "./helpers/constant-resolution-fixture.js";

let fixture: ConstantResolutionFixture;

beforeEach(async () => {
  fixture = await createConstantResolutionFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

async function writeFixture(files: Record<string, string>): Promise<string> {
  return await fixture.write(files);
}

describe("resolveConstantValue — TypeScript", () => {
  async function createProject(): Promise<string> {
    return await writeFixture({
      "src/constants.ts": `export const API_URL = "https://api.example.com"
export const RETRIES = 3
export default API_URL
`,
      "src/config.ts": `import API_URL from "./constants"
import { API_URL as BASE_URL, RETRIES } from "./constants"
import * as constants from "./constants"

export const DEFAULT_URL = BASE_URL
export const DEFAULT_URL_FROM_DEFAULT = API_URL
export const DEFAULT_URL_FROM_NAMESPACE = constants.API_URL
export const CONFIG = { api: BASE_URL, retries: RETRIES }
`,
      "src/api.ts": `import { DEFAULT_URL, CONFIG } from "./config"

export function fetch(url = DEFAULT_URL, retries = CONFIG.retries, enabled = false, missing = other()) {
  return { url, retries, enabled, missing }
}
`,
      "py/constants.py": `API_URL = "https://python.example.com"
`,
    });
  }

  it("resolves imported aliases across TypeScript files", async () => {
    const repo = await createProject();

    const result = await resolveTypeScriptConstantValue(repo, "DEFAULT_URL", { file_pattern: "src/config.ts" });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      language: "typescript",
      file: "src/config.ts",
      resolved: true,
      value_kind: "string",
      value: "https://api.example.com",
      confidence: "medium",
    });
    expect(result.matches[0]!.alias_chain.map((hop) => `${hop.file}:${hop.name}`)).toEqual([
      "src/config.ts:DEFAULT_URL",
      "src/config.ts:BASE_URL",
      "src/constants.ts:API_URL",
    ]);
  });

  it("resolves default imports and namespace member access", async () => {
    const repo = await createProject();

    const fromDefault = await resolveTypeScriptConstantValue(repo, "DEFAULT_URL_FROM_DEFAULT", { file_pattern: "src/config.ts" });
    const fromNamespace = await resolveTypeScriptConstantValue(repo, "DEFAULT_URL_FROM_NAMESPACE", { file_pattern: "src/config.ts" });

    expect(fromDefault.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "string",
      value: "https://api.example.com",
    });
    expect(fromNamespace.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "string",
      value: "https://api.example.com",
    });
  });

  it("resolves TypeScript function default parameters through imports and object properties", async () => {
    const repo = await createProject();

    const result = await resolveTypeScriptConstantValue(repo, "fetch", { file_pattern: "src/api.ts" });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.symbol_kind).toBe("function");
    expect(result.matches[0]!.default_parameters).toEqual([
      expect.objectContaining({
        name: "url",
        resolved: true,
        value_kind: "string",
        value: "https://api.example.com",
      }),
      expect.objectContaining({
        name: "retries",
        resolved: true,
        value_kind: "integer",
        value: 3,
      }),
      expect.objectContaining({
        name: "enabled",
        resolved: true,
        value_kind: "boolean",
        value: false,
      }),
      expect.objectContaining({
        name: "missing",
        resolved: false,
        value_text: "other()",
      }),
    ]);
    expect(result.matches[0]!.resolved).toBe(false);
  });

  it("auto-infers TypeScript in the generic resolver", async () => {
    const repo = await createProject();

    const result = await resolveConstantValue(repo, "DEFAULT_URL", { file_pattern: "src/config.ts" });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      language: "typescript",
      resolved: true,
      value: "https://api.example.com",
    });
  });

  it("returns both Python and TypeScript matches in mixed repos when language is not forced", async () => {
    const repo = await createProject();

    const result = await resolveConstantValue(repo, "API_URL");

    expect(result.matches.map((match) => `${match.language}:${match.file}`)).toEqual([
      "python:py/constants.py",
      "typescript:src/constants.ts",
    ]);
  });

  it("preserves the TypeScript language contract when function source parsing fails", async () => {
    const symbol = {
      id: "repo:src/api.ts:fetch:1",
      repo: "repo",
      name: "fetch",
      kind: "function",
      file: "src/api.ts",
      start_line: 1,
      end_line: 1,
      source: "export function fetch(value = 1) {}",
    } satisfies CodeSymbol;
    const state = {
      parser: { parse: vi.fn(() => null) },
    } as unknown as ResolutionState;

    const result = await resolveFunctionDefaults(symbol, state);

    expect(result).toMatchObject({
      language: "typescript",
      resolved: false,
      reason: "Could not parse source for fetch",
    });
  });

  it("releases the temporary syntax tree used to inspect function defaults", async () => {
    const deleteTree = vi.fn();
    const symbol = {
      id: "repo:src/api.ts:fetch:1",
      repo: "repo",
      name: "fetch",
      kind: "function",
      file: "src/api.ts",
      start_line: 1,
      end_line: 1,
      source: "export function fetch() {}",
    } satisfies CodeSymbol;
    const state = {
      parser: {
        parse: vi.fn(() => ({
          rootNode: { type: "program", namedChildren: [] },
          delete: deleteTree,
        })),
      },
    } as unknown as ResolutionState;

    await resolveFunctionDefaults(symbol, state);

    expect(deleteTree).toHaveBeenCalledOnce();
  });

  it("resolves default parameters from captured arrow-function source", async () => {
    const parser = await getParser("typescript");
    if (!parser) throw new Error("TypeScript parser unavailable in test");
    const symbol = {
      id: "repo:src/api.ts:fetch:1",
      repo: "repo",
      name: "fetch",
      kind: "function",
      file: "src/api.ts",
      start_line: 1,
      end_line: 1,
      source: "export const fetch = (retries = 3) => retries",
    } satisfies CodeSymbol;
    const state = { parser } as unknown as ResolutionState;

    const result = await resolveFunctionDefaults(symbol, state);

    expect(result).toMatchObject({
      language: "typescript",
      resolved: true,
      default_parameters: [{
        name: "retries",
        resolved: true,
        value_kind: "integer",
        value: 3,
        confidence: "high",
        alias_chain: [],
      }],
    });
  });

  it("releases cached syntax trees when a resolution run completes", () => {
    const deleteTree = vi.fn();
    const state = {
      fileCache: new Map<string, TypeScriptFileContext | null>([
        ["src/constants.ts", { tree: { delete: deleteTree } } as unknown as TypeScriptFileContext],
        ["src/missing.ts", null],
      ]),
      retiredTrees: [{ delete: deleteTree }],
    } as unknown as ResolutionState;

    disposeTypeScriptFileContexts(state);

    expect(deleteTree).toHaveBeenCalledTimes(2);
    expect(state.fileCache.size).toBe(0);
    expect(state.retiredTrees).toHaveLength(0);
  });

  it("reports destructured parameter defaults as unsupported instead of silently omitting them", async () => {
    const repo = await writeFixture({
      "src/api.ts": `export function fetch({ retries = 3 } = {}) {
  return retries
}
`,
    });

    const result = await resolveTypeScriptConstantValue(repo, "fetch", { file_pattern: "src/api.ts" });

    expect(result.matches[0]!.default_parameters).toEqual([
      expect.objectContaining({
        name: "{ retries = 3 }",
        resolved: false,
        reason: "Destructured parameter defaults are not supported",
      }),
    ]);
    expect(result.matches[0]!.reason).not.toBe("Function has no default parameters");
  });

  it("resolves bracket access for object values and namespace imports", async () => {
    const repo = await writeFixture({
      "src/base.ts": `export const CONFIG = { api: "https://api.example.com" }
export const RETRIES = 3
`,
      "src/config.ts": `import { CONFIG } from "./base"
import * as base from "./base"

export const URL_FROM_BRACKET = CONFIG["api"]
export const RETRIES_FROM_NAMESPACE_BRACKET = base["RETRIES"]
`,
    });

    const objectResult = await resolveTypeScriptConstantValue(repo, "URL_FROM_BRACKET");
    const namespaceResult = await resolveTypeScriptConstantValue(repo, "RETRIES_FROM_NAMESPACE_BRACKET");

    expect(objectResult.matches[0]).toMatchObject({ resolved: true, value: "https://api.example.com" });
    expect(namespaceResult.matches[0]).toMatchObject({ resolved: true, value: 3 });
  });

  it("enforces max_depth across nested namespace member resolution", async () => {
    const repo = await writeFixture({
      "src/a.ts": "export const VALUE = 1\n",
      "src/b.ts": `import * as a from "./a"
export const B = a.VALUE
`,
      "src/c.ts": `import * as b from "./b"
export const C = b.B
`,
    });

    const result = await resolveTypeScriptConstantValue(repo, "C", { max_depth: 1 });

    expect(result.matches[0]).toMatchObject({
      resolved: false,
      reason: "Max resolution depth (1) exceeded",
    });
  });

  it("allows a direct binding at the exact max_depth boundary", async () => {
    const repo = await writeFixture({
      "src/direct.ts": "export const DIRECT = 1\n",
    });

    const result = await resolveTypeScriptConstantValue(repo, "DIRECT", { max_depth: 0 });

    expect(result.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "integer",
      value: 1,
    });
  });
});
