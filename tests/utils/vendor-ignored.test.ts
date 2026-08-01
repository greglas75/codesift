import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IGNORE_DIRS, toIgnorePatterns } from "../../src/utils/walk/filters.js";
import { walkDirectory } from "../../src/utils/walk.js";

/**
 * `vendor/` is `node_modules` under a different name — Composer, Go, Ruby and
 * Rust all install there — and it was indexed.
 *
 * Measured on real indexes before this: tgm-mobi 44,534 of 50,006 files (89%),
 * Mobi3 89%, tgm-collect 10,083 of 11,622 (87%). Two sat exactly on the
 * 50,000-file cap, so dependency code was pushing the project's own source OUT
 * of the index — silent incompleteness, not just slowness. Graph tools walked
 * the whole vendored tree and blew the 90s tool timeout, making them unusable
 * on every PHP project.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-vendor-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "vendor", "some", "package", "src"), { recursive: true });
  await mkdir(join(dir, "app", "vendor", "nested"), { recursive: true });
  await writeFile(join(dir, "src", "mine.php"), "<?php class Mine {}\n");
  await writeFile(join(dir, "vendor", "some", "package", "src", "Dep.php"), "<?php class Dep {}\n");
  await writeFile(join(dir, "app", "vendor", "nested", "Deep.php"), "<?php class Deep {}\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("vendor/ is treated as third-party", () => {
  it("is ignored alongside node_modules", () => {
    expect(IGNORE_DIRS.has("vendor")).toBe(true);
    expect(IGNORE_DIRS.has("node_modules")).toBe(true);
    expect(toIgnorePatterns()).toContain("**/vendor/**");
  });

  it("is skipped at any depth, keeping first-party source", async () => {
    const files = await walkDirectory(dir, { relative: true });
    const paths = files.map((f) => (typeof f === "string" ? f : f.path));

    expect(paths).toContain("src/mine.php");
    // Both the top-level vendor tree and one nested under a subdirectory.
    expect(paths.some((p) => p.includes("vendor/"))).toBe(false);
  });
});

describe("CODESIFT_INDEX_VENDOR escape hatch", () => {
  it("keeps vendor/ indexable for a repo whose vendor really is source", async () => {
    // Read at module load, so the module has to be re-evaluated.
    const prev = process.env["CODESIFT_INDEX_VENDOR"];
    process.env["CODESIFT_INDEX_VENDOR"] = "1";
    try {
      vi.resetModules();
      const mod = await import("../../src/utils/walk/filters.js");
      expect(mod.IGNORE_DIRS.has("vendor")).toBe(false);
      expect(mod.IGNORE_DIRS.has("node_modules")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["CODESIFT_INDEX_VENDOR"];
      else process.env["CODESIFT_INDEX_VENDOR"] = prev;
      vi.resetModules();
    }
  });
});
