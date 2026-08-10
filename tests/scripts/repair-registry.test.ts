import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const repair = resolve("scripts/repair-registry.mjs");

describe("repair-registry", () => {
  let dir: string;
  let liveRoot: string;
  let orphanRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codesift-registry-repair-"));
    liveRoot = join(dir, "live");
    orphanRoot = join(dir, "orphan");
    mkdirSync(liveRoot);
    mkdirSync(orphanRoot);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeIndex(path: string, repo: string, root: string): void {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE symbols (id TEXT); CREATE TABLE files (path TEXT);");
    const insert = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    insert.run("repo", repo);
    insert.run("root", root);
    db.close();
  }

  it("does not replace a live entry with a clashing orphan", () => {
    const liveIndex = join(dir, "aaaaaaaa.index.json");
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: { "local/repo": { name: "local/repo", root: liveRoot, index_path: liveIndex } },
    }));
    writeIndex(join(dir, "bbbbbbbb.index.db"), "local/repo", orphanRoot);

    const result = spawnSync(process.execPath, [repair, "--apply"], {
      encoding: "utf-8",
      env: { ...process.env, CODESIFT_DATA_DIR: dir },
    });

    expect(result.status).toBe(0);
    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(registry.repos["local/repo"].root).toBe(liveRoot);
    expect(result.stdout).toContain("re-registered 0");
  });
});
