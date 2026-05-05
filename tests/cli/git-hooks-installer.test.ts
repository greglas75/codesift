import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock os.homedir to point at a tmp dir, so the installer touches a sandbox.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

import { installGitHooks } from "../../src/cli/git-hooks-installer.js";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const homedirMock = homedir as unknown as ReturnType<typeof vi.fn>;
const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

describe("installGitHooks", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "codesift-git-hooks-test-"));
    homedirMock.mockReturnValue(sandbox);
    // Default: git is available, no existing hooksPath set.
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git --version") return Buffer.from("git version 2.50.0");
      if (cmd.includes("--get core.hooksPath")) {
        const err = new Error("not set") as Error & { status: number };
        err.status = 1;
        throw err;
      }
      if (cmd.includes("config --global core.hooksPath")) return Buffer.from("");
      return Buffer.from("");
    });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("copies bundled scripts into ~/.claude/{hooks,scripts}/ on first run", async () => {
    const result = await installGitHooks();

    expect(result.installed.length).toBeGreaterThan(0);
    expect(existsSync(join(sandbox, ".claude/hooks/post-commit"))).toBe(true);
    expect(existsSync(join(sandbox, ".claude/scripts/post-commit-review-backlog.sh"))).toBe(true);
    expect(result.hooksPath).toBe(join(sandbox, ".claude/hooks"));
  });

  it("sets git config --global core.hooksPath when not already configured", async () => {
    await installGitHooks();
    const calls = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    const setHookPath = calls.find(
      (c) => typeof c === "string" && c.includes("config --global core.hooksPath"),
    );
    expect(setHookPath).toBeDefined();
  });

  it("is idempotent — second run reports already-installed scripts as skipped", async () => {
    await installGitHooks();
    const second = await installGitHooks();
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.installed.length).toBe(0);
  });

  it("preserves user-modified scripts unless force=true", async () => {
    await installGitHooks();
    const targetPath = join(sandbox, ".claude/scripts/post-commit-review-backlog.sh");
    await writeFile(targetPath, "#!/bin/bash\n# user-modified content\n", "utf-8");

    const result = await installGitHooks();
    expect(result.preserved).toContain(targetPath);
    expect(readFileSync(targetPath, "utf-8")).toContain("user-modified content");
  });

  it("overwrites user modifications when force=true", async () => {
    await installGitHooks();
    const targetPath = join(sandbox, ".claude/scripts/post-commit-review-backlog.sh");
    await writeFile(targetPath, "#!/bin/bash\n# user-modified content\n", "utf-8");

    const result = await installGitHooks({ force: true });
    expect(result.installed).toContain(targetPath);
    expect(readFileSync(targetPath, "utf-8")).not.toContain("user-modified content");
  });

  it("returns reason and skips when git binary is not available", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "git --version") {
        throw new Error("git: command not found");
      }
      return Buffer.from("");
    });

    const result = await installGitHooks();
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/git/i);
    expect(result.installed).toEqual([]);
  });

  it("does not overwrite foreign global core.hooksPath without force", async () => {
    execSyncMock.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
      if (cmd === "git --version") return Buffer.from("git version 2.50.0");
      if (cmd.includes("--get core.hooksPath")) {
        return opts?.encoding === "utf-8" ? "/other/tool/hooks\n" : Buffer.from("/other/tool/hooks\n");
      }
      return Buffer.from("");
    });

    const result = await installGitHooks();
    expect(result.hooksPathSkippedReason).toMatch(/not overwriting/i);
    const setHookPath = execSyncMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && String(c[0]).includes("config --global core.hooksPath"),
    );
    expect(setHookPath).toBeUndefined();
  });

  it("overwrites foreign global core.hooksPath when force=true", async () => {
    execSyncMock.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
      if (cmd === "git --version") return Buffer.from("git version 2.50.0");
      if (cmd.includes("--get core.hooksPath")) {
        return opts?.encoding === "utf-8" ? "/other/tool/hooks\n" : Buffer.from("/other/tool/hooks\n");
      }
      if (cmd.includes("config --global core.hooksPath")) return Buffer.from("");
      return Buffer.from("");
    });

    await installGitHooks({ force: true });
    const setHookPath = execSyncMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && String(c[0]).includes("config --global core.hooksPath"),
    );
    expect(setHookPath).toBeDefined();
  });

  it("restores execute bit when hash matches but post-commit is not executable", async () => {
    await installGitHooks();
    const targetPath = join(sandbox, ".claude/hooks/post-commit");
    await chmod(targetPath, 0o644);

    await installGitHooks();

    const st = await stat(targetPath);
    expect(st.mode & 0o111).not.toBe(0);
  });

  it("does not re-set core.hooksPath when already pointing at the target", async () => {
    const target = join(sandbox, ".claude/hooks");
    execSyncMock.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
      if (cmd === "git --version") return Buffer.from("git version 2.50.0");
      // Code calls execSync with encoding: "utf-8" — return a string in that case.
      if (cmd.includes("--get core.hooksPath")) {
        return opts?.encoding === "utf-8" ? `${target}\n` : Buffer.from(`${target}\n`);
      }
      return Buffer.from("");
    });

    await installGitHooks();
    const calls = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    const setHookPath = calls.find(
      (c) => typeof c === "string" && c.includes("config --global core.hooksPath"),
    );
    // Should NOT have called config --global core.hooksPath since it was already set.
    expect(setHookPath).toBeUndefined();
  });
});
