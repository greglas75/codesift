import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repair-registry", () => {
  it("does not replace a live registry entry when an orphan database claims the same name", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codesift-registry-repair-"));
    dirs.push(dataDir);
    const registeredRoot = join(dataDir, "registered");
    const conflictingRoot = join(dataDir, "conflicting");
    mkdirSync(registeredRoot);
    mkdirSync(conflictingRoot);
    const registryPath = join(dataDir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      repos: {
        "local/app": {
          name: "local/app",
          root: registeredRoot,
          index_path: join(dataDir, "aaaaaaaaaaaa.index.json"),
        },
      },
    }));

    const db = new DatabaseSync(join(dataDir, "bbbbbbbbbbbb.index.db"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE symbols (id TEXT)");
    db.exec("CREATE TABLE files (path TEXT)");
    for (const [key, value] of Object.entries({
      repo: "local/app",
      root: conflictingRoot,
      symbol_count: "10",
      file_count: "2",
      updated_at: "1",
    })) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, value);
    }
    db.close();

    const result = spawnSync(process.execPath, ["scripts/repair-registry.mjs", "--apply"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env, CODESIFT_DATA_DIR: dataDir },
    });

    expect(result.status).toBe(0);
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(registry.repos["local/app"].root).toBe(registeredRoot);
    expect(result.stdout).toContain("skipped local/app");
    expect(result.stdout).toContain("skipped 1 conflicts");
  });
});
