/**
 * Git hooks installer — sets up the global git post-commit hook that auto-updates
 * `docs/review-queue.md` and `~/.claude/projects/<sanitized>/memory/review-backlog.md`.
 *
 * Editor-agnostic: any tool that does `git commit` (Claude Code, Cursor, Codex,
 * Antigravity, plain terminal, GUI clients) will trigger the hook.
 *
 * Strategy:
 *   1. Copy bundled scripts from <package>/hooks/ to ~/.claude/{hooks,scripts}/
 *   2. Set `git config --global core.hooksPath ~/.claude/hooks`
 *   3. Idempotent — safe to re-run; preserves user-modified scripts unless --force
 *
 * Skipped quietly if Git is unavailable (no system git binary).
 */

import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

interface BundledScript {
  /** Path inside the bundled package's `hooks/` directory. */
  source: string;
  /** Absolute install destination on user's system. */
  target: string;
  /** True if the file must be executable. */
  executable: boolean;
}

export interface GitHooksInstallResult {
  installed: string[];
  preserved: string[];
  skipped: string[];
  hooksPath: string;
  reason?: string;
  /** Set when scripts were installed but `git config --global core.hooksPath` was left unchanged. */
  hooksPathSkippedReason?: string;
}

/** Resolve the bundled `hooks/` directory inside the installed npm package. */
function resolveBundledHooksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/git-hooks-installer.js → ../../hooks
  const candidates = [
    join(here, "..", "..", "hooks"),
    join(here, "..", "..", "..", "hooks"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Bundled hooks directory not found. Looked in: ${candidates.join(", ")}`,
  );
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Copy a bundled script preserving user modifications.
 *  - If destination doesn't exist: copy + chmod.
 *  - If exists with same hash as bundled: no-op (already current).
 *  - If exists with different hash: preserve user version unless force=true. */
async function installScript(
  script: BundledScript,
  bundledDir: string,
  force: boolean,
): Promise<"installed" | "preserved" | "skipped"> {
  const sourcePath = join(bundledDir, script.source);
  if (!existsSync(sourcePath)) {
    return "skipped";
  }

  await mkdir(dirname(script.target), { recursive: true });

  if (existsSync(script.target) && !force) {
    const existing = await readFile(script.target, "utf-8");
    const bundled = await readFile(sourcePath, "utf-8");
    if (sha256(existing) === sha256(bundled)) {
      if (script.executable) {
        const st = await stat(script.target);
        if ((st.mode & 0o111) === 0) {
          await chmod(script.target, 0o755);
        }
      }
      return "skipped"; // identical, nothing to do
    }
    return "preserved"; // user-modified, don't overwrite
  }

  await copyFile(sourcePath, script.target);
  if (script.executable) {
    await chmod(script.target, 0o755);
  }
  return "installed";
}

/** True when `git` binary is on PATH. */
function isGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Install global git post-commit hook for review-queue automation.
 *
 * Idempotent. Safe to run multiple times. Preserves user-modified scripts
 * unless `force` is true. */
export async function installGitHooks(
  options: { force?: boolean } = {},
): Promise<GitHooksInstallResult> {
  const force = options.force ?? false;
  const home = homedir();
  const hooksDir = join(home, ".claude", "hooks");
  const scriptsDir = join(home, ".claude", "scripts");

  if (!isGitAvailable()) {
    return {
      installed: [],
      preserved: [],
      skipped: [],
      hooksPath: hooksDir,
      reason: "git binary not found on PATH",
    };
  }

  const bundledDir = resolveBundledHooksDir();

  const scripts: BundledScript[] = [
    {
      source: "post-commit",
      target: join(hooksDir, "post-commit"),
      executable: true,
    },
    {
      source: "hook-chain.sh",
      target: join(hooksDir, "hook-chain.sh"),
      executable: true,
    },
    {
      source: "post-commit-review-backlog.sh",
      target: join(scriptsDir, "post-commit-review-backlog.sh"),
      executable: true,
    },
  ];

  const installed: string[] = [];
  const preserved: string[] = [];
  const skipped: string[] = [];

  for (const script of scripts) {
    const status = await installScript(script, bundledDir, force);
    if (status === "installed") installed.push(script.target);
    else if (status === "preserved") preserved.push(script.target);
    else skipped.push(script.target);
  }

  const postCommitHook = join(hooksDir, "post-commit");
  const postCommitPresent = existsSync(postCommitHook);

  // Set global core.hooksPath only when safe: post-commit exists, and we do not
  // clobber another tool's global hooks directory without --force.
  // Path equality is `realpathSync`-aware so symlinked homes / trailing slashes
  // do not produce false "matches ours" or "matches other" decisions.
  const canonicalize = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  const hooksDirCanonical = canonicalize(hooksDir);
  let hooksPathMatchesOurs = false;
  let otherGlobalHooksPath: string | undefined;
  try {
    const current = execSync("git config --global --get core.hooksPath", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (current) {
      if (canonicalize(current) === hooksDirCanonical) hooksPathMatchesOurs = true;
      else otherGlobalHooksPath = current;
    }
  } catch {
    /* unset — ok to set once bundle is ready */
  }

  let hooksPathSkippedReason: string | undefined;

  if (hooksPathMatchesOurs) {
    // Already correct
  } else if (!postCommitPresent) {
    hooksPathSkippedReason =
      "bundled hooks did not install to ~/.claude/hooks/post-commit; left core.hooksPath unchanged";
  } else if (otherGlobalHooksPath && !force) {
    hooksPathSkippedReason = `global core.hooksPath is already "${otherGlobalHooksPath}" — not overwriting (re-run setup with --force to replace)`;
  } else {
    execSync(`git config --global core.hooksPath ${JSON.stringify(hooksDir)}`, {
      stdio: "ignore",
    });
  }

  return {
    installed,
    preserved,
    skipped,
    hooksPath: hooksDir,
    ...(hooksPathSkippedReason !== undefined
      ? { hooksPathSkippedReason }
      : {}),
  };
}
