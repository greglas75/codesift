import { execFileSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import { collectImportEdges } from "../utils/import-graph.js";

// ---------------------------------------------------------------------------
// Fan-in / Fan-out types
// ---------------------------------------------------------------------------

export interface FanMetric {
  file: string;
  count: number;
  connections: string[];
}

export interface FanInFanOutResult {
  fan_in_top: FanMetric[];
  fan_out_top: FanMetric[];
  hub_files: FanMetric[];
  coupling_score: number;
  total_files: number;
  total_edges: number;
}

// ---------------------------------------------------------------------------
// Co-change types
// ---------------------------------------------------------------------------

export interface CoChangePair {
  file_a: string;
  file_b: string;
  co_commits: number;
  jaccard: number;
  support_a: number;
  support_b: number;
}

export interface CoChangeResult {
  pairs: CoChangePair[];
  clusters: string[][];
  total_commits_analyzed: number;
  period: string;
}

// ---------------------------------------------------------------------------
// fan_in_fan_out
// ---------------------------------------------------------------------------

export async function fanInFanOut(
  repo: string,
  options?: {
    path?: string;
    top_n?: number;
    level?: "file";
  },
): Promise<FanInFanOutResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const topN = options?.top_n ?? 20;
  const focusPath = options?.path;

  // Build file filter set for focus path
  let fileFilter: Set<string> | undefined;
  if (focusPath) {
    fileFilter = new Set(
      index.files.filter((f) => f.path.startsWith(focusPath)).map((f) => f.path),
    );
  }

  const edges = await collectImportEdges(index, fileFilter);

  // Build directed fan-in and fan-out maps
  const fanInMap = new Map<string, Set<string>>();   // file → set of importers
  const fanOutMap = new Map<string, Set<string>>();  // file → set of imports

  for (const edge of edges) {
    // Apply path filter to both sides of the edge
    if (focusPath && !edge.from.startsWith(focusPath) && !edge.to.startsWith(focusPath)) {
      continue;
    }

    // Fan-in: who imports this file
    if (!fanInMap.has(edge.to)) fanInMap.set(edge.to, new Set());
    fanInMap.get(edge.to)!.add(edge.from);

    // Fan-out: what does this file import
    if (!fanOutMap.has(edge.from)) fanOutMap.set(edge.from, new Set());
    fanOutMap.get(edge.from)!.add(edge.to);
  }

  // Collect all files
  const allFiles = new Set<string>();
  for (const f of fanInMap.keys()) allFiles.add(f);
  for (const f of fanOutMap.keys()) allFiles.add(f);

  // Build sorted lists
  const fanInEntries: FanMetric[] = [...fanInMap.entries()]
    .map(([file, importers]) => ({
      file,
      count: importers.size,
      connections: [...importers].sort(),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  const fanOutEntries: FanMetric[] = [...fanOutMap.entries()]
    .map(([file, imports]) => ({
      file,
      count: imports.size,
      connections: [...imports].sort(),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  // Hub files: both fan-in AND fan-out above 75th percentile
  const inCounts = [...fanInMap.values()].map((s) => s.size).sort((a, b) => a - b);
  const outCounts = [...fanOutMap.values()].map((s) => s.size).sort((a, b) => a - b);

  const inP75 = inCounts.length > 0 ? inCounts[Math.floor(inCounts.length * 0.75)]! : 0;
  const outP75 = outCounts.length > 0 ? outCounts[Math.floor(outCounts.length * 0.75)]! : 0;

  const hubFiles: FanMetric[] = [];
  for (const file of allFiles) {
    const inCount = fanInMap.get(file)?.size ?? 0;
    const outCount = fanOutMap.get(file)?.size ?? 0;
    if (inCount > inP75 && outCount > outP75) {
      hubFiles.push({
        file,
        count: inCount + outCount,
        connections: [`in=${inCount}`, `out=${outCount}`],
      });
    }
  }
  hubFiles.sort((a, b) => b.count - a.count);

  // Coupling score: fewer hubs = better
  const totalFiles = allFiles.size;
  const score = totalFiles > 0
    ? Math.max(0, Math.min(100, Math.round(100 - (hubFiles.length / totalFiles) * 100)))
    : 100;

  return {
    fan_in_top: fanInEntries,
    fan_out_top: fanOutEntries,
    hub_files: hubFiles.slice(0, topN),
    coupling_score: score,
    total_files: totalFiles,
    total_edges: edges.length,
  };
}

// ---------------------------------------------------------------------------
// computeCoChangePairs — shared function (extracted from review-diff-tools.ts)
// ---------------------------------------------------------------------------

const DEFAULT_SINCE_DAYS = 180;
const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_MAX_FILES_PER_COMMIT = 50;

export function computeCoChangePairs(
  repoRoot: string,
  options?: {
    since_days?: number;
    min_support?: number;
    max_files_per_commit?: number;
  },
): { pairs: CoChangePair[]; total_commits: number } {
  const sinceDays = options?.since_days ?? DEFAULT_SINCE_DAYS;
  const minSupport = options?.min_support ?? DEFAULT_MIN_SUPPORT;
  const maxFilesPerCommit = options?.max_files_per_commit ?? DEFAULT_MAX_FILES_PER_COMMIT;

  const raw = execFileSync(
    "git",
    [
      "log",
      "--name-only",
      "--no-merges",
      "--diff-filter=AMRC",
      `--since=${sinceDays} days ago`,
      "--pretty=format:%H",
    ],
    { cwd: repoRoot, encoding: "utf-8", timeout: 15000 },
  );

  // Parse commits: SHA\n\nfile1\nfile2\n\nSHA\n\nfile1\nfile2
  const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
  const fileCommitCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  let totalCommits = 0;

  for (let i = 0; i < blocks.length - 1; i += 2) {
    const fileBlock = blocks[i + 1]!;
    const files = fileBlock.split("\n").filter((l) => l.trim().length > 0);

    if (files.length > maxFilesPerCommit) continue;
    totalCommits++;

    for (const file of files) {
      fileCommitCounts.set(file, (fileCommitCounts.get(file) ?? 0) + 1);
    }

    // Count pairs (canonical: sorted alphabetically)
    for (let a = 0; a < files.length; a++) {
      for (let b = a + 1; b < files.length; b++) {
        const pair = [files[a]!, files[b]!].sort().join("\0");
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }

  // Build CoChangePair[] for all pairs above min_support
  const pairs: CoChangePair[] = [];
  for (const [pair, coCount] of pairCounts) {
    if (coCount < minSupport) continue;

    const [fileA, fileB] = pair.split("\0") as [string, string];
    const countA = fileCommitCounts.get(fileA) ?? 0;
    const countB = fileCommitCounts.get(fileB) ?? 0;
    const jaccard = coCount / (countA + countB - coCount);

    pairs.push({
      file_a: fileA,
      file_b: fileB,
      co_commits: coCount,
      jaccard,
      support_a: countA,
      support_b: countB,
    });
  }

  return { pairs, total_commits: totalCommits };
}

// ---------------------------------------------------------------------------
// co_change_analysis
// ---------------------------------------------------------------------------

export async function coChangeAnalysis(
  repo: string,
  options?: {
    since_days?: number;
    min_support?: number;
    min_jaccard?: number;
    path?: string;
    top_n?: number;
  },
): Promise<CoChangeResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const minJaccard = options?.min_jaccard ?? 0.3;
  const focusPath = options?.path;
  const topN = options?.top_n ?? 30;
  const sinceDays = options?.since_days ?? DEFAULT_SINCE_DAYS;

  const coChangeOpts: Parameters<typeof computeCoChangePairs>[1] = { since_days: sinceDays };
  if (options?.min_support != null) coChangeOpts!.min_support = options.min_support;
  const { pairs: allPairs, total_commits } = computeCoChangePairs(index.root, coChangeOpts);

  // Filter by jaccard threshold and focus path
  let filtered = allPairs.filter((p) => p.jaccard >= minJaccard);

  if (focusPath) {
    filtered = filtered.filter(
      (p) => p.file_a.startsWith(focusPath) || p.file_b.startsWith(focusPath),
    );
  }

  // Sort by jaccard descending
  filtered.sort((a, b) => b.jaccard - a.jaccard);
  const topPairs = filtered.slice(0, topN);

  // Cluster detection: connected components where jaccard > 0.7
  const clusters = findClusters(filtered.filter((p) => p.jaccard > 0.7));

  return {
    pairs: topPairs,
    clusters,
    total_commits_analyzed: total_commits,
    period: `${sinceDays} days`,
  };
}

// ---------------------------------------------------------------------------
// Cluster detection via union-find
// ---------------------------------------------------------------------------

function findClusters(pairs: CoChangePair[]): string[][] {
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = parent.get(x)!;
    while (root !== parent.get(root)) {
      root = parent.get(root)!;
    }
    parent.set(x, root); // path compression
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const p of pairs) {
    union(p.file_a, p.file_b);
  }

  // Group by root
  const groups = new Map<string, string[]>();
  for (const file of parent.keys()) {
    const root = find(file);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(file);
  }

  // Return only clusters with 2+ files, sorted by size descending
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((g) => g.sort());
}
