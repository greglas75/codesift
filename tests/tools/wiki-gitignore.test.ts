import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCodesiftGitignored } from "../../src/tools/wiki-tools.js";

describe("ensureCodesiftGitignored", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codesift-gi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .gitignore with .codesift/ when none exists", async () => {
    await ensureCodesiftGitignored(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi.split("\n").map((l) => l.trim())).toContain(".codesift/");
  });

  it("appends the rule, preserving existing .gitignore content", async () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    await ensureCodesiftGitignored(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain("dist/");
    expect(gi.split("\n").map((l) => l.trim())).toContain(".codesift/");
  });

  it("is idempotent — no duplicate rule when already present", async () => {
    writeFileSync(join(dir, ".gitignore"), "# stuff\n.codesift/\n");
    await ensureCodesiftGitignored(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    const count = gi.split("\n").filter((l) => l.trim() === ".codesift/").length;
    expect(count).toBe(1);
  });

  it("treats a bare `.codesift` (no slash) entry as already-present", async () => {
    writeFileSync(join(dir, ".gitignore"), ".codesift\n");
    await ensureCodesiftGitignored(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi.split("\n").filter((l) => l.trim().startsWith(".codesift")).length).toBe(1);
  });

  it("never throws when the repo root is unwritable (best-effort)", async () => {
    // Point at a path that cannot hold a .gitignore — must resolve, not reject.
    await expect(
      ensureCodesiftGitignored(join(dir, "does", "not", "exist", "nested")),
    ).resolves.toBeUndefined();
    expect(existsSync(join(dir, "does"))).toBe(false);
  });
});
