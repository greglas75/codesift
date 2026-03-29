import { describe, it, expect, beforeAll } from "vitest";
import { astQuery } from "../../src/tools/ast-query-tools.js";
import { indexFolder, invalidateCache } from "../../src/tools/index-tools.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

let repo: string;
let testDir: string;

afterAll(async () => {
  if (repo) await invalidateCache(repo).catch(() => {});
  if (testDir) rmSync(testDir, { recursive: true, force: true, maxRetries: 3 });
});

beforeAll(async () => {
  testDir = mkdtempSync(path.join(tmpdir(), "codesift-ast-q-"));
  execSync("git init", { cwd: testDir, stdio: "ignore" });
  execSync("git config user.email test@test.com && git config user.name Test", { cwd: testDir, stdio: "ignore" });

  // Create test TypeScript files
  writeFileSync(
    path.join(testDir, "example.ts"),
    `
function greet(name: string): string {
  return "Hello, " + name;
}

async function fetchData(url: string): Promise<Response> {
  return fetch(url);
}

function noArgs() {
  console.log("hi");
}
`.trim(),
  );

  writeFileSync(
    path.join(testDir, "catches.ts"),
    `
function risky() {
  try {
    doStuff();
  } catch (err) {
    console.log(err);
  }
}

function safe() {
  try {
    doOther();
  } catch (err) {
    throw new Error("wrapped", { cause: err });
  }
}
`.trim(),
  );

  execSync("git add -A && git commit -m init", { cwd: testDir, stdio: "ignore" });
  const result = await indexFolder(testDir, { watch: false });
  repo = result.repo;
}, 30_000);

describe("astQuery", () => {
  it("finds function declarations", async () => {
    const result = await astQuery(repo, "(function_declaration name: (identifier) @name)", {
      language: "typescript",
    });

    expect(result.matches.length).toBeGreaterThanOrEqual(3);
    const names = result.matches.map((m) => m.captures["name"]);
    expect(names).toContain("greet");
    expect(names).toContain("fetchData");
    expect(names).toContain("noArgs");
  });

  it("finds try-catch blocks", async () => {
    const result = await astQuery(repo, "(try_statement) @try", {
      language: "typescript",
    });

    expect(result.matches.length).toBe(2);
  });

  it("respects file_pattern filter", async () => {
    const result = await astQuery(repo, "(function_declaration name: (identifier) @name)", {
      language: "typescript",
      file_pattern: "catches",
    });

    const names = result.matches.map((m) => m.captures["name"]);
    expect(names).toContain("risky");
    expect(names).toContain("safe");
    expect(names).not.toContain("greet");
  });

  it("respects max_matches limit", async () => {
    const result = await astQuery(repo, "(function_declaration name: (identifier) @name)", {
      language: "typescript",
      max_matches: 2,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("throws on invalid query syntax", async () => {
    await expect(
      astQuery(repo, "this is not a valid query", { language: "typescript" }),
    ).rejects.toThrow("Invalid tree-sitter query");
  });

  it("throws on missing repo", async () => {
    await expect(
      astQuery("local/nonexistent", "(identifier) @x"),
    ).rejects.toThrow("Repository not found");
  });

  it("returns files_scanned count", async () => {
    const result = await astQuery(repo, "(function_declaration) @fn", {
      language: "typescript",
    });

    expect(result.files_scanned).toBeGreaterThanOrEqual(2);
  });
});
