import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findWorkingTree } from "../../utils/worktree.js";
import { setupCodex } from "./codex.js";

/**
 * Give a repository its own Codex config so the daemon knows where the session works.
 *
 * Codex keeps MCP configuration in ONE global file, and an HTTP entry carries exactly one
 * directory — so the global entry is deliberately bare (`/mcp`, no `?cwd=`). Without a
 * per-project file the daemon therefore has no working directory at all and answers
 * "does not know your working directory"; repo auto-resolution, which is the documented
 * default, fails for every tool. Measured 2026-08-29: 31 working trees on this machine,
 * ZERO with a project config, and a Codex session in one of them concluded CodeSift could
 * not see its files.
 *
 * Doing it at registration rather than by hand is the point: a repository that CodeSift has
 * just indexed is exactly a repository a Codex session is about to ask about.
 */
export type CodexProjectConfigOutcome =
  | "written"
  | "already-present"
  | "skipped-linked-worktree"
  | "skipped-codex-not-http"
  | "skipped-no-codex"
  | "skipped-disabled"
  | "failed";

/** Opt out with CODESIFT_CODEX_PROJECT_CONFIG=0. */
function disabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env["CODESIFT_CODEX_PROJECT_CONFIG"];
  return raw === "0" || raw === "false";
}

/**
 * Is the GLOBAL Codex entry an HTTP one?
 *
 * This gate is not politeness, it is correctness. Codex MERGES a project file into the global
 * one per key, and a project `url` on top of a global `command` produces a hybrid it refuses to
 * load at all: `Error loading config.toml: url is not supported for stdio`. That failure takes
 * down EVERY other MCP server in the file, not just codesift — so writing a project config
 * against a stdio global is far worse than writing nothing.
 */
async function globalCodexEntryIsHttp(home: string): Promise<boolean> {
  const globalToml = join(home, ".codex", "config.toml");
  if (!existsSync(globalToml)) return false;
  let content: string;
  try {
    content = await readFile(globalToml, "utf-8");
  } catch {
    return false;
  }
  const marker = content.indexOf("[mcp_servers.codesift]");
  if (marker < 0) return false;
  const rest = content.slice(marker + "[mcp_servers.codesift]".length);
  const nextSection = rest.search(/^\s*\[/m);
  const block = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  return /^\s*url\s*=/m.test(block);
}

/**
 * Write `<root>/.codex/config.toml` when — and only when — it is safe and useful.
 *
 * Best effort by design: this runs inside repository registration, and a repository must
 * register whether or not a client's config could be written. Every outcome is a value, not a
 * throw.
 */
export async function ensureCodexProjectConfig(
  root: string,
  options?: { env?: NodeJS.ProcessEnv; home?: string },
): Promise<CodexProjectConfigOutcome> {
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();
  if (disabled(env)) return "skipped-disabled";

  // LINKED WORKTREES ARE DELIBERATELY EXCLUDED. Pointing a worktree at itself makes the daemon
  // index it as a repository of its own, and 27 of those starting at once is what saturated this
  // machine for hours on 2026-08-28. Main checkouts only; a worktree stays on its parent's index
  // until someone opts it in by hand.
  const tree = findWorkingTree(root);
  if (!tree || tree.linked) return "skipped-linked-worktree";

  if (existsSync(join(root, ".codex", "config.toml"))) return "already-present";
  if (!existsSync(join(home, ".codex"))) return "skipped-no-codex";
  if (!(await globalCodexEntryIsHttp(home))) return "skipped-codex-not-http";

  try {
    // `cwd` is BOTH the directory pinned into the URL and the directory the project file is
    // written into — setupCodex derives projectRoot from it. Hooks and rules stay off: this is
    // about one client entry, not about reconfiguring someone's repository.
    await setupCodex({ http: true, projectScope: true, cwd: tree.root, hooks: false, rules: false });
    return "written";
  } catch {
    return "failed";
  }
}
