import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageEntry } from "./usage-tracker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStats {
  tool: string;
  total_calls: number;
  total_result_tokens: number;
  avg_elapsed_ms: number;
  avg_result_tokens: number;
}

export interface RepoStats {
  repo: string;
  call_count: number;
}

export interface DailyStats {
  date: string;   // YYYY-MM-DD
  call_count: number;
  total_tokens: number;
}

export interface UsageStats {
  total_calls: number;
  total_sessions: number;
  avg_calls_per_session: number;
  tools: ToolStats[];
  top_repos: RepoStats[];
  daily: DailyStats[];
  earliest_ts: number;
  latest_ts: number;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function getUsagePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage.jsonl");
}

function isValidEntry(value: unknown): value is UsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["ts"] === "number" &&
    typeof obj["tool"] === "string" &&
    typeof obj["elapsed_ms"] === "number" &&
    typeof obj["session_id"] === "string"
  );
}

async function loadEntries(options?: {
  since?: string;
  repo?: string;
}): Promise<UsageEntry[]> {
  const usagePath = getUsagePath();
  let raw: string;

  try {
    raw = await readFile(usagePath, "utf-8");
  } catch {
    return [];
  }

  const sinceTs = options?.since ? new Date(options.since).getTime() : 0;
  const repoFilter = options?.repo ?? null;
  const entries: UsageEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isValidEntry(parsed)) continue;
      if (parsed.ts < sinceTs) continue;
      if (repoFilter && parsed.repo !== repoFilter) continue;
      entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export async function getUsageStats(options?: {
  since?: string;
  repo?: string;
}): Promise<UsageStats> {
  const entries = await loadEntries(options);

  if (entries.length === 0) {
    return {
      total_calls: 0,
      total_sessions: 0,
      avg_calls_per_session: 0,
      tools: [],
      top_repos: [],
      daily: [],
      earliest_ts: 0,
      latest_ts: 0,
    };
  }

  // Per-tool aggregation
  const toolMap = new Map<string, { calls: number; tokens: number; elapsed: number }>();
  const repoMap = new Map<string, number>();
  const sessionSet = new Set<string>();
  const dailyMap = new Map<string, { calls: number; tokens: number }>();

  let earliest = Infinity;
  let latest = 0;

  for (const entry of entries) {
    // Tool stats
    const existing = toolMap.get(entry.tool) ?? { calls: 0, tokens: 0, elapsed: 0 };
    existing.calls += 1;
    existing.tokens += entry.result_tokens;
    existing.elapsed += entry.elapsed_ms;
    toolMap.set(entry.tool, existing);

    // Repo stats (skip empty)
    if (entry.repo) {
      repoMap.set(entry.repo, (repoMap.get(entry.repo) ?? 0) + 1);
    }

    // Sessions
    sessionSet.add(entry.session_id);

    // Daily
    const date = new Date(entry.ts).toISOString().slice(0, 10);
    const dayStats = dailyMap.get(date) ?? { calls: 0, tokens: 0 };
    dayStats.calls += 1;
    dayStats.tokens += entry.result_tokens;
    dailyMap.set(date, dayStats);

    // Time range
    if (entry.ts < earliest) earliest = entry.ts;
    if (entry.ts > latest) latest = entry.ts;
  }

  // Build sorted arrays
  const tools: ToolStats[] = [...toolMap.entries()]
    .map(([tool, stats]) => ({
      tool,
      total_calls: stats.calls,
      total_result_tokens: stats.tokens,
      avg_elapsed_ms: Math.round(stats.elapsed / stats.calls),
      avg_result_tokens: Math.round(stats.tokens / stats.calls),
    }))
    .sort((a, b) => b.total_calls - a.total_calls);

  const top_repos: RepoStats[] = [...repoMap.entries()]
    .map(([repo, call_count]) => ({ repo, call_count }))
    .sort((a, b) => b.call_count - a.call_count)
    .slice(0, 20);

  const daily: DailyStats[] = [...dailyMap.entries()]
    .map(([date, stats]) => ({
      date,
      call_count: stats.calls,
      total_tokens: stats.tokens,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalSessions = sessionSet.size;

  return {
    total_calls: entries.length,
    total_sessions: totalSessions,
    avg_calls_per_session: Math.round((entries.length / totalSessions) * 10) / 10,
    tools,
    top_repos,
    daily,
    earliest_ts: earliest,
    latest_ts: latest,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUsageReport(stats: UsageStats): string {
  if (stats.total_calls === 0) {
    return "No usage data recorded yet.";
  }

  const lines: string[] = [];

  // Header
  const earliest = new Date(stats.earliest_ts).toISOString().slice(0, 10);
  const latest = new Date(stats.latest_ts).toISOString().slice(0, 10);
  lines.push("=== CodeSift Usage Report ===");
  lines.push(`Period: ${earliest} to ${latest}`);
  lines.push(`Total calls: ${stats.total_calls}`);
  lines.push(`Total sessions: ${stats.total_sessions}`);
  lines.push(`Avg calls/session: ${stats.avg_calls_per_session}`);
  lines.push("");

  // Tool breakdown
  lines.push("--- Tool Breakdown ---");
  const maxToolLen = Math.max(...stats.tools.map((t) => t.tool.length), 4);
  lines.push(
    `${"Tool".padEnd(maxToolLen)}  ${"Calls".padStart(6)}  ${"Tokens".padStart(8)}  ${"Avg ms".padStart(7)}  ${"Avg tok".padStart(7)}`,
  );
  for (const t of stats.tools) {
    lines.push(
      `${t.tool.padEnd(maxToolLen)}  ${String(t.total_calls).padStart(6)}  ${String(t.total_result_tokens).padStart(8)}  ${String(t.avg_elapsed_ms).padStart(7)}  ${String(t.avg_result_tokens).padStart(7)}`,
    );
  }
  lines.push("");

  // Top repos
  if (stats.top_repos.length > 0) {
    lines.push("--- Top Repos ---");
    for (const r of stats.top_repos) {
      lines.push(`  ${r.repo}: ${r.call_count} calls`);
    }
    lines.push("");
  }

  // Daily breakdown (last 14 days max)
  if (stats.daily.length > 0) {
    lines.push("--- Daily Usage ---");
    const recentDays = stats.daily.slice(-14);
    for (const d of recentDays) {
      lines.push(`  ${d.date}: ${d.call_count} calls, ${d.total_tokens} tokens`);
    }
    if (stats.daily.length > 14) {
      lines.push(`  ... and ${stats.daily.length - 14} earlier days`);
    }
  }

  return lines.join("\n");
}
