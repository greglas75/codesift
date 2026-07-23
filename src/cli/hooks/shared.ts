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

export const DEFAULT_MIN_LINES = 200;

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
    return true; // cannot tell → behave as before, do not silently disable the hooks
  }
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
      if (existsSync(meta.index_path)) return true;
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
