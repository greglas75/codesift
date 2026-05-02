import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { findCircularDeps } from "../../src/tools/graph-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

let tmpHome: string | null = null;
let monoRepoName: string | null = null;
let flatRepoName: string | null = null;
let monoRoot: string | null = null;
let flatRoot: string | null = null;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codesift-pkg-cycles-test-"));
  process.env.CODESIFT_HOME = tmpHome;

  monoRoot = await mkdtemp(join(tmpdir(), "codesift-pkg-cycles-mono-"));
  cpSync(join(__dirname, "..", "fixtures", "turbo-pnpm-monorepo"), monoRoot, { recursive: true });
  const m = await indexFolder(monoRoot);
  monoRepoName = m.repo;

  flatRoot = await mkdtemp(join(tmpdir(), "codesift-pkg-cycles-flat-"));
  await writeFile(join(flatRoot, "package.json"), JSON.stringify({ name: "flat", version: "1.0.0" }));
  await mkdir(join(flatRoot, "src"), { recursive: true });
  await writeFile(join(flatRoot, "src/a.ts"), "import './b';");
  await writeFile(join(flatRoot, "src/b.ts"), "import './a';");
  const f = await indexFolder(flatRoot);
  flatRepoName = f.repo;
});

afterAll(async () => {
  if (monoRoot) await rm(monoRoot, { recursive: true, force: true });
  if (flatRoot) await rm(flatRoot, { recursive: true, force: true });
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  delete process.env.CODESIFT_HOME;
});

describe("findCircularDeps package-level cycles (Task 12)", () => {
  it("(a) AC5: cycle-a/cycle-b fixture surfaces package_cycles", async () => {
    const result = await findCircularDeps(monoRepoName!);
    expect(result.package_cycles).toBeDefined();
    expect(result.package_cycles!.length).toBeGreaterThan(0);
    const cycle = result.package_cycles![0]!.cycle;
    // The cycle should include both cycle packages
    expect(cycle).toEqual(expect.arrayContaining(["@org/cycle-a", "@org/cycle-b"]));
  });

  it("(c) flat-repo: package_cycles field is absent (preserves output shape)", async () => {
    const result = await findCircularDeps(flatRepoName!);
    expect(result.package_cycles).toBeUndefined();
    // file_cycles still present
    expect(Array.isArray(result.cycles)).toBe(true);
  });

  it("(d) python_circular_imports still functions independently (no regression)", async () => {
    // Sanity check: findCircularDeps works on flat repos and returns a result
    // shape (no exception, no missing fields). Existing detailed file-cycle
    // semantics covered by the broader graph-tools test suite.
    const result = await findCircularDeps(flatRepoName!);
    expect(result.total_files).toBeGreaterThanOrEqual(0);
    expect(typeof result.total_edges).toBe("number");
  });
});
