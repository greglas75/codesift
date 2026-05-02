import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCodeIndex } from "./index-tools.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SINCE_DAYS = 90;
const MAX_HOTSPOTS = 30;

export interface FileHotspot {
  file: string;
  commits: number;
  lines_changed: number;
  symbol_count: number;
  churn_score: number;       // commits × lines_changed (normalized)
  hotspot_score: number;     // churn_score × symbol_count (higher = more risky)
}

export interface HotspotResult {
  hotspots: FileHotspot[];
  period: string;
  total_files: number;
  total_commits: number;
  /**
   * Diagnostic note populated only when the result is empty or degraded.
   * Audit skills should surface this in their Tool Availability Block as
   * `EMPTY-RESULT (<note>)` instead of silently treating it as "no hotspots".
   */
  note?: string;
}

/**
 * Get git log numstat for a repo: file → { commits, linesChanged }.
 *
 * Async to avoid blocking the MCP server's event loop while git produces output.
 * On a 2,376-commit repo with --numstat, the synchronous variant could block for
 * tens of seconds, exceeding the MCP client's connection timeout (-32000).
 *
 * Returns a tuple of [churn-map, error-note]. error-note is populated when the
 * git invocation failed or produced empty output — caller should surface it
 * rather than treating empty as "no hotspots."
 */
async function getGitChurn(
  repoRoot: string,
  sinceDays: number,
  useAllRefs = false,
): Promise<{ churn: Map<string, { commits: number; linesAdded: number; linesRemoved: number }>; note?: string }> {
  const since = `${sinceDays} days ago`;
  const args = ["log", "--numstat", "--format=%H", `--since=${since}`];
  if (useAllRefs) args.push("--all");

  let output: string;
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB — --numstat on 2k+ commit repos
    });
    output = result.stdout;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[hotspot] git log failed for ${repoRoot}: ${message}`);
    return { churn: new Map(), note: `git log failed: ${message.slice(0, 200)}` };
  }

  if (!output.trim()) {
    return {
      churn: new Map(),
      note: useAllRefs
        ? `git log returned empty output even with --all refs (no commits in last ${sinceDays}d)`
        : `git log returned empty output (no commits in last ${sinceDays}d on current ref)`,
    };
  }

  const churn = new Map<string, { commits: number; linesAdded: number; linesRemoved: number }>();
  const lines = output.split("\n");
  const commitFiles = new Set<string>();
  let inCommit = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line after numstat lines → end of a commit's stats
      // Empty line right after hash → skip (git format: hash\n\nnumstat)
      if (commitFiles.size > 0) {
        for (const file of commitFiles) {
          const entry = churn.get(file);
          if (entry) entry.commits++;
        }
        commitFiles.clear();
      }
      continue;
    }

    // Commit hash line (40 hex chars)
    if (/^[0-9a-f]{40}$/.test(trimmed)) {
      inCommit = true;
      continue;
    }

    if (!inCommit) continue;

    // Numstat line: "added\tremoved\tfile"
    const parts = trimmed.split("\t");
    if (parts.length !== 3) continue;

    const added = parseInt(parts[0]!, 10);
    const removed = parseInt(parts[1]!, 10);
    const file = parts[2]!;

    if (isNaN(added) || isNaN(removed)) continue; // binary file

    let entry = churn.get(file);
    if (!entry) {
      entry = { commits: 0, linesAdded: 0, linesRemoved: 0 };
      churn.set(file, entry);
    }
    entry.linesAdded += added;
    entry.linesRemoved += removed;
    commitFiles.add(file);
  }

  // Handle last commit
  for (const file of commitFiles) {
    const entry = churn.get(file);
    if (entry) entry.commits++;
  }

  return { churn };
}

/**
 * Analyze git churn hotspots: files with high change frequency × complexity.
 * Higher hotspot_score = more likely to contain bugs and need refactoring.
 */
export async function analyzeHotspots(
  repo: string,
  options?: {
    since_days?: number | undefined;
    top_n?: number | undefined;
    file_pattern?: string | undefined;
  },
): Promise<HotspotResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const sinceDays = options?.since_days ?? DEFAULT_SINCE_DAYS;
  const topN = options?.top_n ?? MAX_HOTSPOTS;
  const filePattern = options?.file_pattern;

  let { churn, note } = await getGitChurn(index.root, sinceDays);

  // Empty-result fallback: structure-audit-2026-04-30 saw analyze_hotspots return
  // empty on an active 2,376-commit repo. Cause was never identified (resolver
  // bug + worktree state both possible). Try --all refs as a recovery before
  // giving up — covers detached HEAD, unusual ref configs, and worktrees.
  if (churn.size === 0 && !note?.includes("git log failed")) {
    console.error(`[hotspot] empty churn for ${index.root} on default ref — retrying with --all`);
    const fallback = await getGitChurn(index.root, sinceDays, /* useAllRefs */ true);
    churn = fallback.churn;
    if (churn.size > 0) {
      note = `recovered via --all refs fallback (default ref returned empty)`;
    } else {
      note = fallback.note ?? `empty churn even after --all fallback`;
    }
  }

  // Build symbol count lookup
  const symbolCounts = new Map<string, number>();
  for (const file of index.files) {
    symbolCounts.set(file.path, file.symbol_count);
  }

  const hotspots: FileHotspot[] = [];
  let totalCommits = 0;

  let yieldCounter = 0;
  for (const [file, stats] of churn) {
    if ((++yieldCounter & 511) === 0) await new Promise((r) => setImmediate(r));
    if (filePattern && !file.includes(filePattern)) continue;
    // Skip non-indexed files (node_modules, etc.)
    const symCount = symbolCounts.get(file) ?? 0;
    const linesChanged = stats.linesAdded + stats.linesRemoved;
    const churnScore = stats.commits * linesChanged;
    const hotspotScore = churnScore * Math.max(symCount, 1);

    totalCommits += stats.commits;

    hotspots.push({
      file,
      commits: stats.commits,
      lines_changed: linesChanged,
      symbol_count: symCount,
      churn_score: churnScore,
      hotspot_score: hotspotScore,
    });
  }

  // Sort by hotspot_score descending
  hotspots.sort((a, b) => b.hotspot_score - a.hotspot_score);

  return {
    hotspots: hotspots.slice(0, topN),
    period: `last ${sinceDays} days`,
    total_files: hotspots.length,
    total_commits: Math.round(totalCommits / Math.max(hotspots.length, 1)),
    ...(note ? { note } : {}),
  };
}
