import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { walkDirectory, BACKUP_FILE_PATTERNS } from "../../src/utils/walk.js";

describe("BACKUP_FILE_PATTERNS", () => {
  const cases: Array<[string, boolean]> = [
    ["Real copy.php", true],
    ["Survey copy.php", true],
    ["config.bak", true],
    ["merge.orig", true],
    ["draft~", true],
    ["buffer.swp", true],
    ["buffer.swo", true],
    [".DS_Store", true],
    ["User.php", false],
    ["UserController.php", false],
    ["index.ts", false],
  ];

  for (const [name, shouldMatch] of cases) {
    it(`${shouldMatch ? "matches" : "does not match"} "${name}"`, () => {
      const matched = BACKUP_FILE_PATTERNS.some((re) => re.test(name));
      expect(matched).toBe(shouldMatch);
    });
  }
});

describe("walkDirectory — backup exclusion integration", () => {
  let tmpDir: string;

  afterEach(() => {
    delete process.env.CODESIFT_INCLUDE_BACKUPS;
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  });

  it("excludes backup files by default", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "walk-backup-"));
    writeFileSync(join(tmpDir, "Real.php"), "<?php");
    writeFileSync(join(tmpDir, "Real copy.php"), "<?php");
    writeFileSync(join(tmpDir, "config.bak"), "x");

    const files = await walkDirectory(tmpDir, { relative: true });
    const names = files.map((f) => basename(f));
    expect(names).toEqual(["Real.php"]);
  });

  it("includes backup files when CODESIFT_INCLUDE_BACKUPS=1", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "walk-backup-"));
    writeFileSync(join(tmpDir, "Real.php"), "<?php");
    writeFileSync(join(tmpDir, "Real copy.php"), "<?php");
    writeFileSync(join(tmpDir, "config.bak"), "x");

    process.env.CODESIFT_INCLUDE_BACKUPS = "1";
    const files = await walkDirectory(tmpDir, { relative: true });
    expect(files.length).toBe(3);
  });
});
