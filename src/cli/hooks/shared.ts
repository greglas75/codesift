import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import { homedir } from "node:os";

export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".vue",
  ".svelte",
]);

// Matched to DEFAULT_MAX_BYTES (20 KB), the OTHER gate on the same decision. At the measured
// median of 34 bytes/line for real TypeScript, 20 KB is ~570 lines — so 600 makes the two agree.
// At 200 they disagreed by 10x: the line gate fired on 203 of 642 files in this repo (32%) while
// the byte gate fired on 21 (3%), so the line gate alone decided almost every redirect. A 200-line
// file costs ~5 K tokens to read whole; replacing that with a search plus a bounded read costs
// more, which is the trade an external benchmark measured as +26% cost at no quality gain.
export const DEFAULT_MIN_LINES = 600;

function getRegistryPath(): string {
  return join(process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift"), "registry.json");
}

export function isCwdInsideRepo(cwd: string, repoRoot: string): boolean {
  const pathApi = cwd.includes("\\") || repoRoot.includes("\\") ? pathWin32 : pathPosix;
  const rel = pathApi.relative(repoRoot, cwd);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/**
 * True when a CodeSift MCP server is actually running, i.e. the agent plausibly
 * HAS the tools these hooks redirect to.
 *
 * Without this check the hooks only ask "is the repo indexed on disk?" — which
 * stays true long after the server dies. Three independent agents were observed
 * being denied `grep`/`find`/`Read` and told to "use CodeSift MCP tools" while
 * having no CodeSift tools at all; each ended up smuggling the same search
 * through an inline `python3` script, so the block bought nothing and cost every
 * one of them a detour. Redirecting to a capability the caller does not have is
 * strictly worse than allowing the fallback.
 *
 * Deliberately fails OPEN: any error, or an unreadable process table, means we
 * do not block. The `ps` spawn only happens on the deny path (a find/grep in an
 * indexed repo), never on the common path.
 */
export function isCodesiftServerRunning(): boolean {
  try {
    // Static import — this file ships as ESM, where `require` is undefined. Using
    // it here threw ReferenceError straight into the catch below, which returns
    // true, so the guard silently reported "server running" every single time and
    // never actually unblocked anything.
    const out = execFileSync("ps", ["-Ao", "command"], {
      encoding: "utf-8",
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Match the SERVER entrypoint only. Matching any command containing
    // "codesift-mcp" is far too loose: the CLI hooks themselves
    // (postindex-file, precheck-*) resolve through
    // .../node_modules/codesift-mcp/dist/cli.js, so every edit-triggered hook
    // looked like a running server and the guard never fired.
    return out.split("\n").some((line) => {
      const cmd = line.trim();
      if (!cmd || cmd.includes("precheck-") || cmd.includes("postindex-")) return false;
      if (cmd.includes("dist/server.js")) return true;           // absolute OR relative invocation
      return /(^|\/)codesift-mcp(\s|$)/.test(cmd);               // the codesift-mcp bin, no subcommand
    });
  } catch {
    // Fail OPEN, as the contract above promises. This used to `return true`
    // ("assume running"), which inverted it: callers treat true as "server is
    // up" and go on to deny the tool, so an unreadable process table produced
    // exactly the outage this function exists to prevent — the agent loses the
    // native fallback AND has no CodeSift tools to redirect to.
    return false;
  }
}

/**
 * Does an index actually exist for this registry entry?
 *
 * `index_path` is an IDENTIFIER, not a path that must exist: it always carries the canonical
 * `.index.json` name, and `sqlitePathFor()` derives the `.db` from it. Since the SQLite migration a
 * repo born on that backend never has the `.json` at all — so `existsSync(index_path)` answers
 * "not indexed" for a perfectly healthy repo.
 *
 * That is not theoretical. Measured on this machine: of 581 registry entries the `.json` existed
 * for SIX; the other 575 had their `.db` and nothing else, `local/codesift` among them. Every hook
 * gated on this — precheck-read, precheck-bash, the session check — therefore exited 0 in silence
 * on essentially every repo, which is exactly the "CodeSift never fires" that a benchmark reported
 * and blamed on the repos being unindexed. They were indexed. The check was looking for the wrong
 * file.
 *
 * CLAUDE.md already warns about this trap for anyone AUDITING the registry. The production path
 * was doing it.
 */
function indexArtifactExists(indexPath: string): boolean {
  if (existsSync(indexPath)) return true;
  const sqlitePath = indexPath.endsWith(".json")
    ? `${indexPath.slice(0, -".json".length)}.db`
    : `${indexPath}.db`;
  return existsSync(sqlitePath);
}

export function isCurrentRepoIndexed(): boolean {
  try {
    const raw = readFileSync(getRegistryPath(), "utf-8");
    const parsed = JSON.parse(raw) as { repos?: unknown };
    if (!parsed.repos || typeof parsed.repos !== "object") return false;

    const repos = Object.values(parsed.repos as Record<string, unknown>);
    const cwd = process.cwd();

    for (const repo of repos) {
      if (!repo || typeof repo !== "object") continue;
      const meta = repo as { root?: unknown; index_path?: unknown };
      if (typeof meta.root !== "string" || typeof meta.index_path !== "string") continue;
      if (!isCwdInsideRepo(cwd, meta.root)) continue;
      if (indexArtifactExists(meta.index_path)) return true;
    }
  } catch {
    // Hooks should never block normal shell use if registry inspection fails.
  }
  return false;
}

export function denyTool(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
