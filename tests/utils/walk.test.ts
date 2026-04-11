import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkDirectory } from "../../src/utils/walk.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe.skipIf(process.platform === "win32")("walkDirectory symlinks", () => {
  it("follows symlinks when followSymlinks is true", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-symlink-"));
    const realDir = join(tmpDir, "real");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "file.ts"), "export const x = 1;");

    const linkDir = join(tmpDir, "link");
    await symlink(realDir, linkDir, "dir");

    const files = await walkDirectory(tmpDir, { followSymlinks: true, relative: true });
    expect(files).toContain("real/file.ts");
    expect(files).toContain("link/file.ts");
  });

  it("terminates on circular symlinks without infinite loop", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-cycle-"));
    const dirA = join(tmpDir, "a");
    const dirB = join(tmpDir, "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "file.ts"), "export const a = 1;");
    await writeFile(join(dirB, "file.ts"), "export const b = 1;");

    // Create circular: a/link -> b, b/link -> a
    await symlink(dirB, join(dirA, "link"), "dir");
    await symlink(dirA, join(dirB, "link"), "dir");

    const result = await walkDirectory(tmpDir, { followSymlinks: true, relative: true });
    // Should terminate and contain at least the real files
    expect(result).toContain("a/file.ts");
    expect(result).toContain("b/file.ts");
    // Should not hang — test finishing is the assertion
  });

  it("skips symlinks to missing targets silently", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-broken-"));
    await writeFile(join(tmpDir, "real.ts"), "export const x = 1;");
    await symlink(join(tmpDir, "nonexistent"), join(tmpDir, "broken-link"), "dir");

    const result = await walkDirectory(tmpDir, { followSymlinks: true, relative: true });
    expect(result).toContain("real.ts");
    // Should not throw
  });
});

describe("walkDirectory excludePatterns", () => {
  it("excludes files matching glob patterns", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-exclude-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await mkdir(join(tmpDir, "vendor"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "code");
    await writeFile(join(tmpDir, "vendor/lib.js"), "vendor");

    const files = await walkDirectory(tmpDir, {
      excludePatterns: ["vendor/**"],
      relative: true,
    });

    expect(files).toContain("src/app.ts");
    expect(files).not.toContain("vendor/lib.js");
  });

  it("excludes files matching extension pattern", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-exclude-ext-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "code");
    await writeFile(join(tmpDir, "src/app.generated.ts"), "generated");

    const files = await walkDirectory(tmpDir, {
      excludePatterns: ["**/*.generated.ts"],
      relative: true,
    });

    expect(files).toContain("src/app.ts");
    expect(files).not.toContain("src/app.generated.ts");
  });

  it("supports multiple patterns", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-exclude-multi-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await mkdir(join(tmpDir, "vendor"), { recursive: true });
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "code");
    await writeFile(join(tmpDir, "vendor/lib.js"), "vendor");
    await writeFile(join(tmpDir, "docs/readme.md"), "docs");
    await writeFile(join(tmpDir, "src/temp.log"), "log");

    const files = await walkDirectory(tmpDir, {
      excludePatterns: ["vendor/**", "**/*.log", "docs/**"],
      relative: true,
    });

    expect(files).toContain("src/app.ts");
    expect(files).not.toContain("vendor/lib.js");
    expect(files).not.toContain("docs/readme.md");
    expect(files).not.toContain("src/temp.log");
  });

  it("returns all files when excludePatterns is empty", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-exclude-empty-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/a.ts"), "a");
    await writeFile(join(tmpDir, "src/b.ts"), "b");

    const files = await walkDirectory(tmpDir, {
      excludePatterns: [],
      relative: true,
    });

    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  it("works alongside IGNORE_DIRS", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-walk-exclude-combo-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await mkdir(join(tmpDir, "build"), { recursive: true }); // IGNORE_DIRS
    await mkdir(join(tmpDir, "vendor"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "code");
    await writeFile(join(tmpDir, "build/out.js"), "built");
    await writeFile(join(tmpDir, "vendor/lib.js"), "vendor");

    const files = await walkDirectory(tmpDir, {
      excludePatterns: ["vendor/**"],
      relative: true,
    });

    expect(files).toContain("src/app.ts");
    expect(files).not.toContain("build/out.js");  // IGNORE_DIRS
    expect(files).not.toContain("vendor/lib.js"); // excludePatterns
  });
});
