import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resolveConstantValue } from "../../src/tools/python-constants-tools.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-python-constants-"));
  fixtureDir = join(tmpDir, "python-constants-project");
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

describe("resolveConstantValue", () => {
  it("resolves direct literals and same-file aliases", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/constants.py": `API_URL = "https://api.example.com"
DEFAULT_URL = API_URL
FLAGS = ["a", "b"]
`,
    });

    const result = await resolveConstantValue(repo, "DEFAULT_URL");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      symbol_name: "DEFAULT_URL",
      resolved: true,
      value_kind: "string",
      value: "https://api.example.com",
      confidence: "high",
    });
    expect(result.matches[0]!.alias_chain.map((hop) => hop.name)).toEqual(["DEFAULT_URL", "API_URL"]);
  });

  it("resolves imported aliases across Python files", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/constants.py": `API_URL = "https://api.example.com"
`,
      "app/config.py": `from .constants import API_URL as BASE_URL

DEFAULT = BASE_URL
`,
    });

    const result = await resolveConstantValue(repo, "DEFAULT", { file_pattern: "app/config.py" });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      file: "app/config.py",
      resolved: true,
      value_kind: "string",
      value: "https://api.example.com",
      confidence: "medium",
    });
    expect(result.matches[0]!.alias_chain.map((hop) => `${hop.file}:${hop.name}`)).toEqual([
      "app/config.py:DEFAULT",
      "app/config.py:BASE_URL",
      "app/constants.py:API_URL",
    ]);
  });

  it("resolves function default parameters through local and imported constants", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/constants.py": `COUNT = 5
`,
      "app/api.py": `from .constants import COUNT

DEFAULT_URL = "https://api.example.com"

def fetch(limit: int = COUNT, url: str = DEFAULT_URL, enabled=False, missing=other()):
    pass
`,
    });

    const result = await resolveConstantValue(repo, "fetch", { file_pattern: "app/api.py" });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.symbol_kind).toBe("function");
    expect(result.matches[0]!.default_parameters).toEqual([
      expect.objectContaining({
        name: "limit",
        resolved: true,
        value_kind: "integer",
        value: 5,
      }),
      expect.objectContaining({
        name: "url",
        resolved: true,
        value_kind: "string",
        value: "https://api.example.com",
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

  it("reports unresolved dynamic constants instead of guessing", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/settings.py": `TIMEOUT = int("5")
`,
    });

    const result = await resolveConstantValue(repo, "TIMEOUT");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.resolved).toBe(false);
    expect(result.matches[0]!.reason).toContain("Unsupported Python value node");
    expect(result.matches[0]!.value_text).toBe('int("5")');
  });

  it("returns an empty list when the symbol does not exist in Python scope", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/constants.py": `API_URL = "https://api.example.com"
`,
    });

    const result = await resolveConstantValue(repo, "MISSING_SYMBOL");

    expect(result.matches).toEqual([]);
  });
});
