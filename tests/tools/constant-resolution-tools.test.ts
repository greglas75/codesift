import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resolveConstantValue } from "../../src/tools/constant-resolution-tools.js";
import { resolveTypeScriptConstantValue } from "../../src/tools/typescript-constants-tools.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-constant-resolution-"));
  fixtureDir = join(tmpDir, "constant-resolution-project");
  await mkdir(fixtureDir, { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeFixture(files: Record<string, string>): Promise<string> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = join(fixtureDir, relativePath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content);
  }
  return (await indexFolder(fixtureDir, { watch: false })).repo;
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
});
