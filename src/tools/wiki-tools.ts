import { writeFile, mkdir, readFile, readdir, rename, unlink, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCurrentGitCommit } from "../utils/git-head.js";
import { getCodeIndex } from "./index-tools.js";
import { detectCommunities } from "./community-tools.js";
import { classifySymbolRoles } from "./graph-tools.js";
import { coChangeAnalysis, fanInFanOut } from "./coupling-tools.js";
import { analyzeHotspots } from "./hotspot-tools.js";
import { analyzeProject } from "./project-tools.js";
import { computeIndexHash } from "../storage/graph-store.js";
import {
  computeSurpriseScores,
  type CommunityInfo,
  type CrossEdge,
  type CoChangePair,
} from "./wiki-surprise.js";
import {
  generateCommunityPage,
  generateCommunitySummary,
  generateHubsPage,
  generateSurprisePage,
  generateHotspotsPage,
  generateFrameworkPage,
  generateIndexPage,
  generateOverviewPage,
  generateArchitecturePage,
  type HubSymbol,
  type FileHotspot,
  type FrameworkInfo,
  type CommunityPageData,
} from "./wiki-page-generators.js";
import { resolveWikiLinks } from "./wiki-links.js";
import { buildUniqueSlugs, type WikiManifest, type WikiManifestV2, type PageInfo, type ModuleMetadata, type ProjectOverview } from "./wiki-manifest.js";
import { buildWikiManifestV1, buildWikiManifestV2, buildProjectOverview, buildModuleMetadata } from "./wiki-module-builder.js";
import { rankHubsByPageRank } from "./wiki-hub-ranker.js";
import { collectImportEdges } from "../utils/import-graph.js";

// ---------------------------------------------------------------------------
// Timeout sentinel
// ---------------------------------------------------------------------------

interface TimeoutSentinel {
  status: "timeout";
}
const TIMEOUT_SENTINEL: TimeoutSentinel = { status: "timeout" };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | TimeoutSentinel> {
  return Promise.race([
    promise,
    new Promise<TimeoutSentinel>((resolve) =>
      setTimeout(() => resolve(TIMEOUT_SENTINEL), ms),
    ),
  ]);
}

function isTimeout(v: unknown): v is TimeoutSentinel {
  return typeof v === "object" && v !== null && "status" in v && (v as TimeoutSentinel).status === "timeout";
}

const ANALYSIS_TIMEOUT = 15000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WikiResult {
  wiki_dir: string;
  pages: number;
  communities: number;
  hubs: number;
  surprises: number;
  degraded: boolean;
  degraded_reasons?: string[];
}

// ---------------------------------------------------------------------------
// Helpers: settled-result unwrapping
// ---------------------------------------------------------------------------

function formatDegradedReason(label: string, result: PromiseSettledResult<unknown>): string {
  if (result.status === "rejected") {
    return `${label}_error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
  }
  return `${label}_timeout`;
}

function unwrapSettled<T, R>(
  result: PromiseSettledResult<T | TimeoutSentinel>,
  label: string,
  extractor: (value: T) => R,
  fallback: R,
  degradedReasons: string[],
): R {
  if (result.status === "fulfilled" && !isTimeout(result.value)) {
    try {
      return extractor(result.value as T);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      degradedReasons.push(`${label}_parse_error: ${msg}`);
      return fallback;
    }
  }
  degradedReasons.push(formatDegradedReason(label, result));
  return fallback;
}

// ---------------------------------------------------------------------------
// Helper: load old manifest if present
// ---------------------------------------------------------------------------

async function loadOldManifest(outputDir: string): Promise<unknown> {
  try {
    const raw = await readFile(join(outputDir, "manifest.json"), "utf-8");
    return JSON.parse(raw as string) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Best-effort: ensure the repo's .gitignore excludes `.codesift/`. The index +
 * wiki live under `<repo>/.codesift/`, are per-machine, and regenerate on every
 * edit — committing them is pure churn. Appends the ignore rule once if missing.
 * Never throws (CQ8): wiki generation must not fail on gitignore IO.
 */
export async function ensureCodesiftGitignored(repoRoot: string): Promise<void> {
  try {
    const giPath = join(repoRoot, ".gitignore");
    let current = "";
    try {
      current = await readFile(giPath, "utf-8");
    } catch {
      // no .gitignore yet — it will be created by the append below
    }
    const hasRule = current
      .split("\n")
      .some((l) => l.trim() === ".codesift/" || l.trim() === ".codesift");
    if (hasRule) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(
      giPath,
      `${prefix}\n# CodeSift auto-generated index + wiki (per-repo, regenerated on edits) — do not commit\n.codesift/\n`,
    );
  } catch {
    // best-effort — never block wiki generation on gitignore IO
  }
}

export async function generateWiki(
  repo: string,
  options?: {
    focus?: string;
    output_dir?: string;
    journal_mode?: "skip" | "refresh-overview" | "append" | "full";
    journal_since_ref?: string;
    journal_bulk_fill?: boolean;
  },
): Promise<WikiResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const outputDir = options?.output_dir ?? join(index.root, ".codesift", "wiki");

  // Path traversal guard
  if (options?.output_dir) {
    const resolved = resolve(options.output_dir);
    const root = resolve(index.root);
    if (!resolved.startsWith(root + "/") && resolved !== root) {
      throw new Error(`output_dir "${options.output_dir}" is outside the repository root — path traversal not allowed`);
    }
  }

  await mkdir(outputDir, { recursive: true });

  // The wiki + whole .codesift/ dir is auto-generated, per-repo, and regenerated
  // on edits — committing it is churn. Ensure the repo ignores it so it never
  // lands on a branch. Best-effort; never blocks generation.
  await ensureCodesiftGitignored(index.root);

  // Lockfile: prevent concurrent wiki generation
  const lockPath = join(outputDir, ".wiki-lock");
  try {
    await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
  } catch {
    throw new Error("Wiki generation already in progress (lockfile exists)");
  }

  try {

  // Fan out all analyses in parallel with per-analysis timeout
  const [commResult, rolesResult, fanResult, coChangeResult, hotspotsResult] =
    await Promise.allSettled([
      withTimeout(detectCommunities(repo, options?.focus), ANALYSIS_TIMEOUT),
      withTimeout(classifySymbolRoles(repo, {}), ANALYSIS_TIMEOUT),
      withTimeout(fanInFanOut(repo, {}), ANALYSIS_TIMEOUT),
      withTimeout(coChangeAnalysis(repo, {}), ANALYSIS_TIMEOUT),
      withTimeout(analyzeHotspots(repo, {}), ANALYSIS_TIMEOUT),
    ]);

  // analyzeProject is best-effort only (used for framework detection)
  const [projectResult] = await Promise.allSettled([
    withTimeout(analyzeProject(repo), ANALYSIS_TIMEOUT),
  ]);

  const degradedReasons: string[] = [];

  // Paths that indicate build artifacts, not source code
  const EXCLUDED_PATH_PATTERNS = [
    /[\\/]node_modules[\\/]/,
    /[\\/]\.next[\\/]/,
    /[\\/]_next[\\/]/,
    /[\\/]dist[\\/]/,
    /[\\/]build[\\/]/,
    /[\\/]output[\\/]/,
    /[\\/]\.output[\\/]/,
    /[\\/]coverage[\\/]/,
    /[\\/]\.cache[\\/]/,
    /[\\/]prisma[\\/]migrations[\\/]/,
    /\.chunk\.[a-f0-9]+\./,
    /\.min\.(js|css)$/,
  ];

  function isSourceFile(path: string): boolean {
    return !EXCLUDED_PATH_PATTERNS.some((re) => re.test(path));
  }

  // Extract community data AND cross-community edge counts
  interface RawCommunity { name: string; files: string[]; external_edges: number; internal_edges: number; }
  let rawCommunities: RawCommunity[] = [];

  const communities = unwrapSettled(commResult, "community_detection", (cr) => {
    if ("communities" in cr) {
      // Filter out communities that are mostly build artifacts
      const filtered = cr.communities.filter((c) => {
        const sourceFiles = c.files.filter(isSourceFile);
        return sourceFiles.length >= 2; // at least 2 real source files
      });
      rawCommunities = filtered.map((c) => {
        const sourceFiles = c.files.filter(isSourceFile);
        return {
          name: c.name, files: sourceFiles,
          external_edges: c.external_edges, internal_edges: c.internal_edges,
        };
      });
      return filtered.map((c) => {
        const sourceFiles = c.files.filter(isSourceFile);
        return { name: c.name, files: sourceFiles, size: sourceFiles.length };
      });
    }
    return [] as CommunityInfo[];
  }, [] as CommunityInfo[], degradedReasons);

  // Build cross-community edges from file membership overlap
  // For each pair of communities, count how many files in community A
  // have external_edges pointing to community B (approximated by shared file proximity)
  const crossEdges: CrossEdge[] = [];
  if (rawCommunities.length >= 2) {
    // Build file → community index
    const fileToCommunityIdx = new Map<string, number>();
    for (let i = 0; i < rawCommunities.length; i++) {
      for (const f of rawCommunities[i]!.files) {
        fileToCommunityIdx.set(f, i);
      }
    }
    // Approximate cross-edges: distribute each community's external_edges
    // proportionally among neighbor communities (by file count ratio)
    // Simple heuristic: if community A has N external edges and B has M files,
    // the weight A→B ≈ external_edges_A * (files_B / total_other_files)
    const totalFiles = rawCommunities.reduce((s, c) => s + c.files.length, 0);
    for (let i = 0; i < rawCommunities.length; i++) {
      const extEdges = rawCommunities[i]!.external_edges;
      if (extEdges === 0) continue;
      const otherFiles = totalFiles - rawCommunities[i]!.files.length;
      if (otherFiles === 0) continue;
      for (let j = i + 1; j < rawCommunities.length; j++) {
        const weight = Math.round(extEdges * (rawCommunities[j]!.files.length / otherFiles));
        if (weight > 0) {
          crossEdges.push({
            from_community: rawCommunities[i]!.name,
            to_community: rawCommunities[j]!.name,
            from_file: rawCommunities[i]!.files[0] ?? "",
            to_file: rawCommunities[j]!.files[0] ?? "",
          });
        }
      }
    }
  }

  const hubSymbols = unwrapSettled(rolesResult, "classify_roles", (roles) =>
    roles
      .filter((r) => r.role === "core" || r.role === "utility" || r.callers >= 3)
      .slice(0, 30)
      .map((r) => ({ name: r.name, file: r.file, role: r.role, callers: r.callers, callees: r.callees })),
  [] as HubSymbol[], degradedReasons);

  const coChangePairs = unwrapSettled(coChangeResult, "cochange", (v) =>
    v.pairs.map((p) => ({ file_a: p.file_a, file_b: p.file_b, jaccard: p.jaccard })),
  [] as CoChangePair[], degradedReasons);

  // Fan-in/fan-out: only record degraded reason, no data extracted
  unwrapSettled(fanResult, "fanin", () => null, null, degradedReasons);

  const fileHotspots = unwrapSettled(hotspotsResult, "hotspots", (v) =>
    v.hotspots.slice(0, 20).map((h) => ({ file: h.file, commits: h.commits, hotspot_score: h.hotspot_score })),
  [] as FileHotspot[], degradedReasons);

  const frameworkInfo = unwrapSettled(projectResult, "project", (v) => {
    const fw = v.stack?.framework;
    return fw ? { name: fw, details: `Primary framework detected: ${fw}.` } as FrameworkInfo : null;
  }, null as FrameworkInfo | null, degradedReasons);

  // Compute surprise scores
  const globalDensity = index.files.length > 0 ? crossEdges.length / (index.files.length * index.files.length) : 0;
  const surprises = computeSurpriseScores(communities, crossEdges, coChangePairs, globalDensity);

  // --- V2 data pipeline (Task 21) ---------------------------------------
  const v1Mode = process.env.CODESIFT_WIKI_V1 === "1";

  // Load the full ProjectProfile from disk — analyzeProject returns a summary,
  // but module-builder + overview need the full shape (identity, stack details,
  // dependency_health, git_health, known_gotchas).
  let fullProfile: import("./project-tools.js").ProjectProfile | null = null;
  if (projectResult.status === "fulfilled" && !isTimeout(projectResult.value)) {
    try {
      const profilePath = projectResult.value.profile_path;
      const raw = await readFile(profilePath, "utf-8");
      fullProfile = JSON.parse(raw) as import("./project-tools.js").ProjectProfile;
    } catch (err) {
      degradedReasons.push(`project_profile_read_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build unique slugs (collision-safe) before page generation.
  const isMonorepo = fullProfile?.identity?.project_type === "monorepo";
  const workspaces = fullProfile?.stack?.monorepo?.workspaces ?? [];
  const slugMap = buildUniqueSlugs(communities, { monorepo: isMonorepo, workspaces });

  let importEdges: Awaited<ReturnType<typeof collectImportEdges>> = [];
  try {
    importEdges = await collectImportEdges(index);
  } catch (err) {
    degradedReasons.push(`import_edges_error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // PageRank-ranked hubs with builtin blocklist. Falls back gracefully to the
  // classifySymbolRoles-sorted hubs when the graph is empty.
  const rankedResult = rankHubsByPageRank(importEdges, hubSymbols, { topK: 30 });
  const rankedHubs = rankedResult.hubs;
  if (rankedResult.degraded_reason) {
    degradedReasons.push(`hub_ranker_${rankedResult.degraded_reason}`);
  }
  const effectiveHubs: HubSymbol[] = rankedHubs.length > 0 ? rankedHubs : hubSymbols;

  // Project overview + structured module metadata.
  let projectOverview: ProjectOverview | null = null;
  let modules: ModuleMetadata[] = [];
  if (!v1Mode && fullProfile) {
    try {
      const overview = buildProjectOverview(fullProfile, index);
      const { _degraded, ...clean } = overview;
      if (_degraded) degradedReasons.push(_degraded);
      projectOverview = clean as ProjectOverview;
    } catch (err) {
      degradedReasons.push(`project_overview_error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      modules = buildModuleMetadata(
        communities, fullProfile, index, importEdges, fileHotspots, rankedHubs,
      );
    } catch (err) {
      degradedReasons.push(`module_metadata_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const slugToModule = new Map<string, ModuleMetadata>(modules.map((m) => [m.slug, m]));

  // Build community page data
  const communityPages: PageInfo[] = communities.map((comm) => {
    const slug = slugMap.get(comm.name) ?? comm.name;
    const commHotspots = fileHotspots.filter((h) => comm.files.includes(h.file));
    const commHubs = hubSymbols.filter((h) => comm.files.includes(h.file));
    const rawComm = commResult.status === "fulfilled" && !isTimeout(commResult.value) && "communities" in commResult.value
      ? commResult.value.communities.find((c) => c.name === comm.name)
      : undefined;
    const data: CommunityPageData = {
      community: comm,
      cohesion: rawComm?.cohesion ?? 0,
      internal_edges: rawComm?.internal_edges ?? 0,
      external_edges: rawComm?.external_edges ?? 0,
      hotspots: commHotspots,
      hub_symbols: commHubs,
    };
    const content = generateCommunityPage(data, slugToModule.get(slug));
    return { slug, title: comm.name, type: "community" as const, file: `${slug}.md`, content };
  });

  // Write community summary files for hook injection
  const slugToCommunity = new Map<string, CommunityInfo>();
  for (const comm of communities) {
    const slug = slugMap.get(comm.name);
    if (slug) slugToCommunity.set(slug, comm);
  }
  for (const comm of communityPages) {
    const data = slugToCommunity.get(comm.slug);
    if (!data) continue;
    const commHotspots = fileHotspots.filter((h) => data.files.includes(h.file));
    const commHubs = hubSymbols.filter((h) => data.files.includes(h.file));
    const rawComm = commResult.status === "fulfilled" && !isTimeout(commResult.value) && "communities" in commResult.value
      ? commResult.value.communities.find((c) => c.name === data.name)
      : undefined;
    const summaryData: CommunityPageData = {
      community: data,
      cohesion: rawComm?.cohesion ?? 0,
      internal_edges: rawComm?.internal_edges ?? 0,
      external_edges: rawComm?.external_edges ?? 0,
      hotspots: commHotspots,
      hub_symbols: commHubs,
    };
    const summary = generateCommunitySummary(summaryData, slugToModule.get(comm.slug));
    await writeFile(join(outputDir, `${comm.slug}.summary.md`), summary, "utf-8");
  }

  // Hubs page — prefer PageRank-ranked hubs when available
  const hubsContent = generateHubsPage(effectiveHubs);
  const hubsPage: PageInfo = { slug: "hubs", title: "Hub Symbols", type: "hubs", file: "hubs.md", content: hubsContent };

  // Surprises page
  const surprisesContent = generateSurprisePage(surprises);
  const surprisesPage: PageInfo = { slug: "surprises", title: "Surprise Connections", type: "surprises", file: "surprises.md", content: surprisesContent };

  // Hotspots page
  const hotspotsContent = generateHotspotsPage(fileHotspots);
  const hotspotsPage: PageInfo = { slug: "hotspots", title: "Hotspot Files", type: "hotspots", file: "hotspots.md", content: hotspotsContent };

  // Framework page (only if framework detected)
  const frameworkPages: PageInfo[] = [];
  if (frameworkInfo) {
    const content = generateFrameworkPage(frameworkInfo);
    if (content) {
      frameworkPages.push({ slug: "framework", title: `Framework: ${frameworkInfo.name}`, type: "framework", file: "framework.md", content });
    }
  }

  // Overview + architecture pages (v2 only, when overview is available)
  const overviewPages: PageInfo[] = [];
  if (projectOverview) {
    overviewPages.push({
      slug: "overview",
      title: projectOverview.name,
      type: "overview" as never,
      file: "overview.md",
      content: generateOverviewPage(projectOverview, modules),
    });
  }
  if (modules.length >= 3) {
    overviewPages.push({
      slug: "architecture",
      title: "Architecture",
      type: "architecture" as never,
      file: "architecture.md",
      content: generateArchitecturePage(modules),
    });
  }

  // Collect all content pages (excluding index) for index generation
  const contentPages: PageInfo[] = [
    ...overviewPages,
    ...communityPages,
    hubsPage,
    surprisesPage,
    hotspotsPage,
    ...frameworkPages,
  ];

  // Index page (v2 uses project overview for tailored heading when available)
  const indexContent = generateIndexPage(
    contentPages.map((p) => ({ slug: p.slug, title: p.title, type: p.type })),
    projectOverview ?? undefined,
  );
  const indexPage: PageInfo = { slug: "index", title: "Wiki Index", type: "index", file: "index.md", content: indexContent };

  const allPages: PageInfo[] = [indexPage, ...contentPages];

  // Resolve wiki links (two-pass backlink injection)
  const pageMap = new Map<string, string>(allPages.map((p) => [p.slug, p.content]));
  const knownSlugs = new Set<string>(allPages.map((p) => p.slug));
  const { resolvedPages } = resolveWikiLinks(pageMap, knownSlugs);

  // Update PageInfo content with resolved versions
  const resolvedPageInfos: PageInfo[] = allPages.map((p) => ({
    ...p,
    content: resolvedPages.get(p.slug) ?? p.content,
  }));

  // Load old manifest for slug_redirects preservation
  const oldManifest = await loadOldManifest(outputDir);

  // Build manifest — v2 by default, v1 when CODESIFT_WIKI_V1=1 or no overview
  const indexHash = computeIndexHash(index.files);
  // 5s timeout here (manifest generation tolerates a slow git better than the
  // SessionStart hook does). Falls back to "unknown" so the rest of the
  // manifest is still valid for downstream consumers.
  const gitCommit = getCurrentGitCommit(index.root, 5000) ?? "unknown";
  const useV2 = !v1Mode && projectOverview !== null;
  const manifest: WikiManifest | WikiManifestV2 = useV2
    ? buildWikiManifestV2({
        index_hash: indexHash,
        git_commit: gitCommit,
        pages: resolvedPageInfos,
        communities,
        project: projectOverview as ProjectOverview,
        modules,
        degradedReasons,
        ...(oldManifest !== undefined ? { oldManifest: oldManifest as WikiManifest | WikiManifestV2 } : {}),
      })
    : buildWikiManifestV1({
        index_hash: indexHash,
        git_commit: gitCommit,
        pages: resolvedPageInfos,
        communities,
        degradedReasons,
        ...(oldManifest !== undefined ? { oldManifest: oldManifest as WikiManifest } : {}),
      });

  // Add lens_data to manifest for dashboard visualization
  if (communities.length >= 2) {
    const lensComms = communities.map((c) => {
      const slug = slugMap.get(c.name) ?? c.name;
      const raw = rawCommunities.find((r) => r.name === c.name);
      const cohesion = raw ? (raw.internal_edges / Math.max(raw.internal_edges + raw.external_edges, 1)) : 0;
      return { name: c.name, slug, fileCount: c.size, cohesion };
    });
    // Build edge list with weights from cross-community external edges
    const lensEdges: Array<{ from: number; to: number; weight: number }> = [];
    const totalFiles = communities.reduce((s, c) => s + c.size, 0);
    for (let i = 0; i < rawCommunities.length; i++) {
      const ext = rawCommunities[i]?.external_edges ?? 0;
      if (ext === 0) continue;
      const otherFiles = totalFiles - (rawCommunities[i]?.files.length ?? 0);
      if (otherFiles === 0) continue;
      for (let j = i + 1; j < rawCommunities.length; j++) {
        const w = Math.round(ext * ((rawCommunities[j]?.files.length ?? 0) / otherFiles));
        if (w > 0) lensEdges.push({ from: i, to: j, weight: w });
      }
    }
    manifest.lens_data = { communities: lensComms, edges: lensEdges };
  }

  // Write pages
  for (const page of resolvedPageInfos) {
    await writeFile(join(outputDir, page.file), page.content, "utf-8");
  }

  // Stale page cleanup: delete .md files from a previous run that are no longer generated.
  // Protected prefixes are plain path-prefix strings (NOT globs) — see pruneStaleWikiFiles
  // contract for exact semantics. "journal" protects the wiki journal (D1 safeguard).
  const newFiles = new Set(resolvedPageInfos.map((p) => p.file));
  newFiles.add("wiki-manifest.json");
  newFiles.add("wiki-manifest.json.tmp");
  newFiles.add(".wiki-lock");
  // Add summary files to known set so they aren't cleaned up
  for (const comm of communityPages) {
    newFiles.add(`${comm.slug}.summary.md`);
  }
  await pruneStaleWikiFiles(outputDir, newFiles, ["journal"]);

  // Atomic manifest write: write to .tmp then rename
  const manifestPath = join(outputDir, "wiki-manifest.json");
  const tmpPath = manifestPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  await rename(tmpPath, manifestPath);

  // Journal dispatch (lazy import — no penalty when mode=skip)
  const mode = options?.journal_mode ?? "skip";
  if (mode !== "skip") {
    const { runJournalInit, runJournalAppend, refreshOverviewAndRollup } = await import("./journal-generator.js");
    const baseOpts = { cwd: process.cwd(), outputDir };
    try {
      if (mode === "refresh-overview") {
        await refreshOverviewAndRollup(baseOpts);
      } else if (mode === "append") {
        if (!options?.journal_since_ref) {
          degradedReasons.push("journal_since_ref required when journal_mode=append");
        } else {
          await runJournalAppend({ ...baseOpts, since: options.journal_since_ref });
        }
      } else if (mode === "full") {
        const r = await runJournalInit({ ...baseOpts, bulkFill: options?.journal_bulk_fill ?? false });
        if (r.phases.every((p) => p.costUsd === 0)) {
          degradedReasons.push("journal: no LLM API key, wrote scaffold");
        }
      }
    } catch (err) {
      degradedReasons.push(`journal dispatch: ${(err as Error).message}`);
    }
  }

  return {
    wiki_dir: outputDir,
    pages: resolvedPageInfos.length,
    communities: communities.length,
    hubs: hubSymbols.length,
    surprises: surprises.length,
    degraded: degradedReasons.length > 0,
    ...(degradedReasons.length > 0 ? { degraded_reasons: degradedReasons } : {}),
  };

  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Delete `.md` files under `outputDir` that are not part of the freshly generated
 * page set, while skipping any entry protected by `protectedPrefixes`.
 *
 * Contract invariant — `protectedPrefixes` are plain path-prefix strings, NOT globs:
 * - Skip `f` where `f === p` OR `f.startsWith(p + "/")` for any `p ∈ protectedPrefixes`.
 * - Skip entries where `!f.endsWith(".md")` (directories and non-markdown files).
 * - Skip entries present in `knownFiles`.
 * - Everything else is `unlink()`-ed.
 *
 * Currently called with a non-recursive `readdir`, but the guard is defence-in-depth
 * for any future refactor that surfaces nested paths such as `"journal/phases/x.md"`
 * (see wiki-journal spec D1 failure mode).
 *
 * @returns absolute paths of the files that were deleted
 */
export async function pruneStaleWikiFiles(
  outputDir: string,
  knownFiles: Set<string>,
  protectedPrefixes: string[],
): Promise<string[]> {
  const entries = await readdir(outputDir);
  const deleted: string[] = [];
  for (const f of entries) {
    // Guard: plain path-prefix match (NOT glob). Exact match or "prefix/" descendant.
    const isProtected = protectedPrefixes.some(
      (p) => f === p || f.startsWith(p + "/"),
    );
    if (isProtected) continue;
    if (!f.endsWith(".md")) continue;
    if (knownFiles.has(f)) continue;
    const full = join(outputDir, f);
    try {
      await unlink(full);
      deleted.push(full);
    } catch (err) {
      console.warn(
        `[wiki-cleanup] could not remove stale file ${full}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // continue — best-effort cleanup; see D1 failure mode in spec
    }
  }
  return deleted;
}
