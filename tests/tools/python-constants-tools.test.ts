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

  it("distinguishes Python lists from tuples", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/collections.py": `FLAGS = ["a", "b"]
COORDINATES = (10, 20)
`,
    });

    const flags = await resolveConstantValue(repo, "FLAGS");
    const coordinates = await resolveConstantValue(repo, "COORDINATES");

    expect(flags.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "list",
      value: ["a", "b"],
    });
    expect(coordinates.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "tuple",
      value: [10, 20],
    });
  });

  it("reports alias cycles before exhausting max_depth", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/cycles.py": `FIRST = SECOND
SECOND = FIRST
`,
    });

    const result = await resolveConstantValue(repo, "FIRST");

    expect(result.matches[0]).toMatchObject({
      resolved: false,
      reason: "Cycle detected while resolving FIRST",
    });
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

  it("normalizes finite numeric literals without returning rounded integers", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/numbers.py": `READABLE = 1_000_000
HEX_MASK = 0xFF_FF
TOO_LARGE = 9007199254740993
TOO_LARGE_FLOAT = 1e400
`,
    });

    const readable = await resolveConstantValue(repo, "READABLE");
    const hexMask = await resolveConstantValue(repo, "HEX_MASK");
    const tooLarge = await resolveConstantValue(repo, "TOO_LARGE");
    const tooLargeFloat = await resolveConstantValue(repo, "TOO_LARGE_FLOAT");

    expect(readable.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "integer",
      value: 1_000_000,
    });
    expect(hexMask.matches[0]).toMatchObject({
      resolved: true,
      value_kind: "integer",
      value: 65_535,
    });
    expect(tooLarge.matches[0]).toMatchObject({
      resolved: false,
      value_text: "9007199254740993",
      reason: "Integer literal exceeds JavaScript safe integer range: 9007199254740993",
    });
    expect(tooLarge.matches[0]).not.toHaveProperty("value");
    expect(tooLargeFloat.matches[0]).toMatchObject({
      resolved: false,
      value_text: "1e400",
      reason: "Float literal is outside the supported finite range: 1e400",
    });
    expect(tooLargeFloat.matches[0]).not.toHaveProperty("value");
  });

  it("preserves Python unary numeric semantics", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/unary.py": `NEGATIVE = -5
POSITIVE = +5
INVERTED = ~5
INVALID_INVERT = ~1.5
`,
    });

    const negative = await resolveConstantValue(repo, "NEGATIVE");
    const positive = await resolveConstantValue(repo, "POSITIVE");
    const inverted = await resolveConstantValue(repo, "INVERTED");
    const invalidInvert = await resolveConstantValue(repo, "INVALID_INVERT");

    expect(negative.matches[0]).toMatchObject({ resolved: true, value: -5, value_text: "-5" });
    expect(positive.matches[0]).toMatchObject({ resolved: true, value: 5, value_text: "+5" });
    expect(inverted.matches[0]).toMatchObject({ resolved: true, value: -6, value_text: "~5" });
    expect(invalidInvert.matches[0]).toMatchObject({
      resolved: false,
      value_text: "~1.5",
      reason: "Unsupported unary operator or operand: ~1.5",
    });
  });

  it("enforces max_depth across same-file alias chains", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/aliases.py": `BASE = 5
ALIAS = BASE
`,
    });

    const bounded = await resolveConstantValue(repo, "ALIAS", { max_depth: 0 });
    const permitted = await resolveConstantValue(repo, "ALIAS", { max_depth: 1 });

    expect(bounded.matches[0]).toMatchObject({
      resolved: false,
      reason: "Max resolution depth (0) exceeded",
    });
    expect(permitted.matches[0]).toMatchObject({ resolved: true, value: 5 });
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
