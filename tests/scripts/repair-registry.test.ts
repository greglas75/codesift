import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/repair-registry.mjs");
let dir: string;

function writeIndexDb(path: string, repo: string, root: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE symbols (id TEXT);
    CREATE TABLE files (path TEXT);
  `);
  const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("repo", repo);
  insert.run("root", root);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-repair-registry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repair-registry", () => {
  it("does not replace a live same-name registry owner with an orphan database", () => {
    const registeredRoot = join(dir, "registered-root");
    const orphanRoot = join(dir, "orphan-root");
    mkdirSync(registeredRoot);
    mkdirSync(orphanRoot);
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: {
        "local/app": {
          name: "local/app",
          root: registeredRoot,
          index_path: join(dir, "aaaaaaaaaaaa.index.json"),
        },
      },
    }));
    writeIndexDb(join(dir, "bbbbbbbbbbbb.index.db"), "local/app", orphanRoot);

    execFileSync(process.execPath, [SCRIPT, "--apply"], {
      env: { ...process.env, CODESIFT_DATA_DIR: dir },
      stdio: "pipe",
    });

    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(registry.repos["local/app"].root).toBe(registeredRoot);
  });

  it("replaces a dead owner when exactly one live database can own the name", () => {
    const rescuedRoot = join(dir, "rescued-root");
    mkdirSync(rescuedRoot);
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: {
        "local/app": {
          name: "local/app",
          root: join(dir, "deleted-root"),
          index_path: join(dir, "aaaaaaaaaaaa.index.json"),
        },
      },
    }));
    writeIndexDb(join(dir, "bbbbbbbbbbbb.index.db"), "local/app", rescuedRoot);

    execFileSync(process.execPath, [SCRIPT, "--apply"], {
      env: { ...process.env, CODESIFT_DATA_DIR: dir },
      stdio: "pipe",
    });

    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(registry.repos["local/app"]).toMatchObject({
      root: rescuedRoot,
      index_path: join(dir, "bbbbbbbbbbbb.index.json"),
    });
  });
});
