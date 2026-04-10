import { getCodeIndex } from "./index-tools.js";
import { analyzeProject } from "./project-tools.js";
import { detectCommunities } from "./community-tools.js";
import { findCircularDeps } from "./graph-tools.js";
import { fanInFanOut } from "./coupling-tools.js";
import type { Community } from "./community-tools.js";
import type { FanMetric } from "./coupling-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirStat {
  dir: string;
  file_count: number;
  symbol_count: number;
}

export interface ArchitectureSummaryResult {
  stack: unknown;
  communities: Community[];
  coupling_hotspots: FanMetric[];
  circular_deps: string[][];
  loc_distribution: DirStat[];
  entry_points: string[];
  mermaid?: string | undefined;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Timeout helper (matches review-diff-tools.ts pattern)
// ---------------------------------------------------------------------------

interface TimeoutSentinel { status: "timeout" }

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | TimeoutSentinel> {
  return Promise.race([
    promise,
    new Promise<TimeoutSentinel>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), ms),
    ),
  ]);
}

function isTimeout(v: unknown): v is TimeoutSentinel {
  return v != null && typeof v === "object" && "status" in v && (v as TimeoutSentinel).status === "timeout";
}

// ---------------------------------------------------------------------------
// LOC distribution (from index, no external calls)
// ---------------------------------------------------------------------------

function computeLocDistribution(
  files: Array<{ path: string; symbol_count: number }>,
  focus?: string,
): DirStat[] {
  const dirMap = new Map<string, { file_count: number; symbol_count: number }>();

  for (const file of files) {
    if (focus && !file.path.startsWith(focus)) continue;

    // Extract top-level directory (or root for flat files)
    const parts = file.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, 2).join("/") : ".";

    const entry = dirMap.get(dir) ?? { file_count: 0, symbol_count: 0 };
    entry.file_count++;
    entry.symbol_count += file.symbol_count;
    dirMap.set(dir, entry);
  }

  return [...dirMap.entries()]
    .map(([dir, stats]) => ({ dir, ...stats }))
    .sort((a, b) => b.symbol_count - a.symbol_count);
}

// ---------------------------------------------------------------------------
// Mermaid diagram generation
// ---------------------------------------------------------------------------

function generateMermaid(
  communities: Community[],
  hubFiles: FanMetric[],
  circularDeps: string[][],
): string {
  const lines: string[] = ["graph TD"];

  // Community subgraphs
  for (const community of communities.slice(0, 10)) {
    const id = `c${community.id}`;
    lines.push(`  subgraph ${id}["${community.name} (${community.files.length} files)"]`);
    // Show up to 5 representative files
    for (const file of community.files.slice(0, 5)) {
      const nodeId = file.replace(/[^a-zA-Z0-9]/g, "_");
      const shortName = file.split("/").pop() ?? file;
      lines.push(`    ${nodeId}["${shortName}"]`);
    }
    if (community.files.length > 5) {
      lines.push(`    ${id}_more["... +${community.files.length - 5} more"]`);
    }
    lines.push("  end");
  }

  // Hub files (coupling hotspots)
  for (const hub of hubFiles.slice(0, 5)) {
    const nodeId = hub.file.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${nodeId}:::hub`);
  }

  // Circular dependency arrows
  for (const cycle of circularDeps.slice(0, 5)) {
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i]!.replace(/[^a-zA-Z0-9]/g, "_");
      const to = cycle[(i + 1) % cycle.length]!.replace(/[^a-zA-Z0-9]/g, "_");
      lines.push(`  ${from} -->|cycle| ${to}`);
    }
  }

  lines.push("  classDef hub fill:#f96,stroke:#333");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 15000;

export async function architectureSummary(
  repo: string,
  options?: {
    focus?: string;
    output_format?: "text" | "mermaid";
    token_budget?: number;
  },
): Promise<ArchitectureSummaryResult> {
  const startMs = Date.now();

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const focus = options?.focus;

  // Build options carefully to avoid passing undefined with exactOptionalPropertyTypes
  const fanOpts: { top_n: number; path?: string } = { top_n: 10 };
  if (focus) fanOpts.path = focus;
  const circOpts: { max_cycles: number; file_pattern?: string } = { max_cycles: 10 };
  if (focus) circOpts.file_pattern = focus;

  // Fan-out 5 analyses in parallel
  const [stackResult, commResult, fanResult, circResult] = await Promise.allSettled([
    withTimeout(analyzeProject(repo), CHECK_TIMEOUT_MS),
    withTimeout(detectCommunities(repo, focus), CHECK_TIMEOUT_MS),
    withTimeout(fanInFanOut(repo, fanOpts), CHECK_TIMEOUT_MS),
    withTimeout(findCircularDeps(repo, circOpts), CHECK_TIMEOUT_MS),
  ]);

  // Extract results (gracefully handle timeouts/failures)
  const stack = stackResult.status === "fulfilled" && !isTimeout(stackResult.value)
    ? stackResult.value
    : null;

  const communities: Community[] = commResult.status === "fulfilled" && !isTimeout(commResult.value)
    ? (commResult.value as { communities: Community[] }).communities ?? []
    : [];

  const couplingHotspots: FanMetric[] = fanResult.status === "fulfilled" && !isTimeout(fanResult.value)
    ? (fanResult.value as { hub_files: FanMetric[] }).hub_files ?? []
    : [];

  const fanInTop: FanMetric[] = fanResult.status === "fulfilled" && !isTimeout(fanResult.value)
    ? (fanResult.value as { fan_in_top: FanMetric[] }).fan_in_top ?? []
    : [];

  const fanOutTop: FanMetric[] = fanResult.status === "fulfilled" && !isTimeout(fanResult.value)
    ? (fanResult.value as { fan_out_top: FanMetric[] }).fan_out_top ?? []
    : [];

  const circularDeps: string[][] = circResult.status === "fulfilled" && !isTimeout(circResult.value)
    ? ((circResult.value as { cycles: Array<{ cycle: string[] }> }).cycles ?? []).map((c) => c.cycle)
    : [];

  // LOC distribution from index (no async needed)
  const locDistribution = computeLocDistribution(index.files, focus);

  // Entry points: high fan-in, low fan-out
  const entryPoints: string[] = [];
  for (const item of fanInTop) {
    const outCount = fanOutTop.find((f) => f.file === item.file)?.count ?? 0;
    if (item.count >= 5 && outCount <= 3) {
      entryPoints.push(item.file);
    }
  }

  // Optional Mermaid
  const mermaid = options?.output_format === "mermaid"
    ? generateMermaid(communities, couplingHotspots, circularDeps)
    : undefined;

  return {
    stack,
    communities,
    coupling_hotspots: couplingHotspots,
    circular_deps: circularDeps,
    loc_distribution: locDistribution,
    entry_points: entryPoints,
    mermaid,
    duration_ms: Date.now() - startMs,
  };
}
