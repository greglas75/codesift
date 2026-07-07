import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix as pathPosix, relative } from "node:path";
import { homedir, hostname } from "node:os";
import { getCurrentGitCommit } from "../../utils/git-head.js";

export const WIKI_MANIFEST_REL = join(".codesift", "wiki", "wiki-manifest.json");
const WIKI_SUMMARY_DEFAULT_MAX_CHARS = 2500;
const WIKI_OVERVIEW_DEFAULT_MAX_CHARS = 1800;

export function wikiSummaryMaxChars(): number {
  return positiveIntEnv("CODESIFT_WIKI_SUMMARY_MAX_CHARS", WIKI_SUMMARY_DEFAULT_MAX_CHARS);
}

export function wikiOverviewMaxChars(): number {
  return positiveIntEnv("CODESIFT_WIKI_OVERVIEW_MAX_CHARS", WIKI_OVERVIEW_DEFAULT_MAX_CHARS);
}

export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function findRepoRootFromDir(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    try {
      readFileSync(join(dir, WIKI_MANIFEST_REL));
      return dir;
    } catch {
      // manifest not found at this level
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findRepoRoot(filePath: string): string | null {
  return findRepoRootFromDir(dirname(filePath));
}

export function logWikiEvent(tool: string, repo: string, args: Record<string, unknown>, resultTokens = 0, sessionId?: string | null): void {
  try {
    if (process.env.CODESIFT_WIKI_TELEMETRY === "0") return;
    const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
    const entry = {
      ts: Date.now(),
      tool,
      repo,
      args_summary: args,
      elapsed_ms: 0,
      result_tokens: resultTokens,
      result_chunks: 0,
      session_id: sessionId ?? process.env["CLAUDE_SESSION_ID"] ?? "hook",
      host: process.env["CODESIFT_HOST_TAG"] ?? hostname(),
    };
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, "usage.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // Telemetry must never break the hook.
  }
}

export function tryLoadWikiSummary(filePath: string): string | null {
  try {
    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) return null;

    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(join(repoRoot, WIKI_MANIFEST_REL), "utf-8");
    } catch {
      return null;
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const fileToComm = manifest["file_to_community"];
    if (!fileToComm || typeof fileToComm !== "object") return null;
    const map = fileToComm as Record<string, unknown>;

    const relPath = pathPosix.normalize(relative(repoRoot, filePath).split("\\").join("/"));
    const communitySlug = map[relPath];
    if (typeof communitySlug !== "string") return null;
    if (!/^[a-z0-9-]+$/.test(communitySlug)) return null;

    let summary: string;
    try {
      summary = readFileSync(join(repoRoot, ".codesift", "wiki", `${communitySlug}.summary.md`), "utf-8");
    } catch {
      return null;
    }

    const maxChars = wikiSummaryMaxChars();
    return summary.length > maxChars ? summary.slice(0, maxChars) : summary;
  } catch {
    return null;
  }
}

export function tryLoadProjectOverview(repoRoot: string): string | null {
  try {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, WIKI_MANIFEST_REL), "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (manifest["schema_version"] !== 2) return null;

    const project = manifest["project"];
    if (!project || typeof project !== "object") return null;
    const p = project as Record<string, unknown>;
    const stack = (p["stack"] ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

    const lines: string[] = [];
    lines.push(`\n\nCodeSift project wiki (architecture map — use instead of re-discovering structure):`);

    const name = str(p["name"]) ?? "this repo";
    const stackBits = [
      str(stack["language"]),
      str(stack["framework"]),
      str(stack["test_runner"]) ? `test:${str(stack["test_runner"])}` : null,
      str(stack["package_manager"]) ? `pm:${str(stack["package_manager"])}` : null,
    ].filter(Boolean);
    lines.push(`Project: ${name}${stackBits.length ? ` — ${stackBits.join(" · ")}` : ""}`);

    const entry = p["entry_points"];
    if (Array.isArray(entry) && entry.length > 0) {
      lines.push(`Entry points: ${entry.filter((e) => typeof e === "string").slice(0, 5).join(", ")}`);
    }

    const modules = manifest["modules"];
    if (Array.isArray(modules) && modules.length > 0) {
      lines.push(`Modules (${modules.length}):`);
      for (const m of modules.slice(0, 14)) {
        if (!m || typeof m !== "object") continue;
        const mod = m as Record<string, unknown>;
        const mName = str(mod["name"]) ?? str(mod["slug"]) ?? "module";
        let desc = str(mod["description"]) ?? "";
        if (desc.length > 110) desc = desc.slice(0, 107) + "…";
        lines.push(`  - ${mName}${desc ? `: ${desc}` : ""}`);
      }
    }

    const gotchas = p["known_gotchas"];
    if (Array.isArray(gotchas) && gotchas.length > 0) {
      const top = gotchas
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .sort((a, b) => sevRank(b["severity"]) - sevRank(a["severity"]))
        .slice(0, 2)
        .map((g) => str(g["gotcha"]))
        .filter(Boolean);
      if (top.length > 0) lines.push(`Gotchas: ${top.join(" | ")}`);
    }

    lines.push(
      "Need detail beyond this map? Pull on demand: get_knowledge_map(focus=<module>) for dependencies, assemble_context(level=\"L3\") for a directory overview, search_symbols/get_file_outline for a specific area — don't hand-walk the tree.",
    );

    if (process.env.CODESIFT_WIKI_STALENESS_CHECK !== "0") {
      const manifestCommit = str(manifest["git_commit"]);
      const head = getCurrentGitCommit(repoRoot);
      if (manifestCommit && manifestCommit !== "unknown" && head && !head.startsWith(manifestCommit) && !manifestCommit.startsWith(head)) {
        lines.push(`(Wiki generated at ${manifestCommit.slice(0, 8)}; HEAD is ${head.slice(0, 8)} — auto-refreshes on edits.)`);
      }
    }

    const out = lines.join("\n");
    const max = wikiOverviewMaxChars();
    if (out.length <= max) return out;
    const truncated = out.slice(0, max);
    const lastNl = truncated.lastIndexOf("\n");
    return lastNl > 0 ? truncated.slice(0, lastNl) : truncated;
  } catch {
    return null;
  }
}

function sevRank(s: unknown): number {
  return s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
}
