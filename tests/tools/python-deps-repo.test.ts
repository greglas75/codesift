/**
 * analyze_python_deps and parse_pyproject over a REAL index.
 *
 * Both read only the repo root from the index (ADR-004 stage 2: the summary, not the materialised
 * index). These cases pin the repo-level behaviour — resolving the root, reading the manifest,
 * and the not-found error — which the pure parser tests do not touch.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { analyzePythonDeps } from "../../src/tools/python-deps-analyzer.js";
import { parsePyproject } from "../../src/tools/pyproject-tools.js";

let tmpDir: string;
let projectDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-python-deps-"));
  projectDir = join(tmpDir, "project");
  await mkdir(join(projectDir, "app"), { recursive: true });
  await writeFile(join(projectDir, "app", "__init__.py"), "");
  await writeFile(join(projectDir, "app", "main.py"), "def main():\n    return 1\n");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function index(): Promise<string> {
  return (await indexFolder(projectDir, { watch: false })).repo;
}

describe("analyzePythonDeps over an indexed repo", () => {
  it("reads dependencies from pyproject.toml at the indexed root", async () => {
    await writeFile(join(projectDir, "pyproject.toml"), `[project]
name = "demo"
dependencies = [
    "django>=4.2",
    "requests",
]
`);
    const repo = await index();

    const result = await analyzePythonDeps(repo);

    expect(result.source).toBe("pyproject.toml");
    expect(result.dependencies.map((d) => d.name)).toEqual(["django", "requests"]);
    expect(result.unpinned_count).toBe(1);
  });

  it("falls back to requirements.txt when there is no pyproject.toml", async () => {
    await writeFile(join(projectDir, "requirements.txt"), "flask==3.0\n");
    const repo = await index();

    const result = await analyzePythonDeps(repo);

    expect(result.source).toBe("requirements.txt");
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: "flask", declared_version: "==3.0" }),
    ]);
  });

  it("keeps the not-found error for an unindexed repo", async () => {
    await expect(analyzePythonDeps("local/no-such-python-repo")).rejects.toThrow(
      'Repository "local/no-such-python-repo" not found.',
    );
  });
});

describe("parsePyproject over an indexed repo", () => {
  it("parses the manifest at the indexed root", async () => {
    // Multi-line on purpose: the parser only recognises a `dependencies` array closed by `\n]`.
    await writeFile(join(projectDir, "pyproject.toml"), `[project]
name = "demo"
dependencies = [
    "celery~=5.3",
]
`);
    const repo = await index();

    const info = await parsePyproject(repo);

    expect(info?.name).toBe("demo");
    expect(info?.dependencies).toEqual([{ name: "celery", version: "~=5.3" }]);
  });

  it("returns null when the indexed root has no pyproject.toml", async () => {
    const repo = await index();
    expect(await parsePyproject(repo)).toBeNull();
  });

  it("keeps the not-found error for an unindexed repo", async () => {
    await expect(parsePyproject("local/no-such-python-repo")).rejects.toThrow(
      'Repository "local/no-such-python-repo" not found.',
    );
  });
});
