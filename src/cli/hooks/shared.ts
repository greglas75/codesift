import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  if (cwd === repoRoot) return true;
  const rootWithSep = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  return cwd.startsWith(rootWithSep);
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
