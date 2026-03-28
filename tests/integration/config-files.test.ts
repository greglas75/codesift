import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-config-"));
  fixtureDir = join(tmpDir, "test-project");
  await mkdir(fixtureDir, { recursive: true });
  // Init git repo so indexFolder doesn't fail
  execSync("git init", { cwd: fixtureDir, stdio: "ignore" });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("config file indexing (DD2)", () => {
  it("indexes .env files as config with zero symbols", async () => {
    await writeFile(join(fixtureDir, ".env"), "API_KEY=secret123\nDB_URL=postgres://localhost");
    await writeFile(join(fixtureDir, "app.ts"), "export const x = 1;");
    await indexFolder(fixtureDir);
    const repoName = `local/${fixtureDir.split("/").pop()}`;
    const index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const envEntry = index!.files.find((f) => f.path === ".env");
    expect(envEntry).toBeDefined();
    expect(envEntry!.language).toBe("config");
    expect(envEntry!.symbol_count).toBe(0);
  });

  it("indexes .yaml files as config with zero symbols", async () => {
    await writeFile(join(fixtureDir, "config.yaml"), "key: value\nlist:\n  - item1");
    // Need at least one parseable file for indexFolder to succeed
    await writeFile(join(fixtureDir, "app.ts"), "export const x = 1;");
    await indexFolder(fixtureDir);
    const repoName = `local/${fixtureDir.split("/").pop()}`;
    const index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const yamlEntry = index!.files.find((f) => f.path === "config.yaml");
    expect(yamlEntry).toBeDefined();
    expect(yamlEntry!.language).toBe("config");
    expect(yamlEntry!.symbol_count).toBe(0);
  });

  it("indexes .toml files as config with zero symbols", async () => {
    await writeFile(join(fixtureDir, "config.toml"), '[database]\nhost = "localhost"');
    await writeFile(join(fixtureDir, "app.ts"), "export const x = 1;");
    await indexFolder(fixtureDir);
    const repoName = `local/${fixtureDir.split("/").pop()}`;
    const index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const tomlEntry = index!.files.find((f) => f.path === "config.toml");
    expect(tomlEntry).toBeDefined();
    expect(tomlEntry!.language).toBe("config");
    expect(tomlEntry!.symbol_count).toBe(0);
  });

  it("indexes .json files as config with zero symbols", async () => {
    await writeFile(join(fixtureDir, "settings.json"), '{"key": "value"}');
    await writeFile(join(fixtureDir, "app.ts"), "export const x = 1;");
    await indexFolder(fixtureDir);
    const repoName = `local/${fixtureDir.split("/").pop()}`;
    const index = await getCodeIndex(repoName);
    expect(index).not.toBeNull();
    const jsonEntry = index!.files.find((f) => f.path === "settings.json");
    expect(jsonEntry).toBeDefined();
    expect(jsonEntry!.language).toBe("config");
    expect(jsonEntry!.symbol_count).toBe(0);
  });
});
