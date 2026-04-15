import { writeFile, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  generateHubsPage,
  generateSurprisePage,
  generateHotspotsPage,
  generateFrameworkPage,
  generateIndexPage,
  type HubSymbol,
  type FileHotspot,
  type FrameworkInfo,
  type CommunityPageData,
} from "./wiki-page-generators.js";
import { resolveWikiLinks } from "./wiki-links.js";
import { buildWikiManifest, type WikiManifest, type PageInfo } from "./wiki-manifest.js";

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
// Helpers: slug conversion
// ---------------------------------------------------------------------------

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

export async function generateWiki(
  repo: string,
  options?: { focus?: string; output_dir?: string },
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

  // Unwrap communities
  let communities: CommunityInfo[] = [];
  let crossEdges: CrossEdge[] = [];
  if (commResult.status === "fulfilled" && !isTimeout(commResult.value)) {
    const cr = commResult.value;
    if ("communities" in cr) {
      communities = cr.communities.map((c) => ({
        name: c.name,
        files: c.files,
        size: c.files.length,
      }));
    }
  } else {
    degradedReasons.push(
      commResult.status === "rejected"
        ? `community_detection_error: ${commResult.reason instanceof Error ? commResult.reason.message : String(commResult.reason)}`
        : "community_detection_timeout",
    );
  }

  // Unwrap roles (hub symbols)
  let hubSymbols: HubSymbol[] = [];
  if (rolesResult.status === "fulfilled" && !isTimeout(rolesResult.value)) {
    const roles = rolesResult.value;
    hubSymbols = roles
      .filter((r) => r.role === "core" || r.role === "utility" || r.callers >= 3)
      .slice(0, 30)
      .map((r) => ({ name: r.name, file: r.file, role: r.role, callers: r.callers, callees: r.callees }));
  } else {
    degradedReasons.push(
      rolesResult.status === "rejected"
        ? `classify_roles_error: ${rolesResult.reason instanceof Error ? rolesResult.reason.message : String(rolesResult.reason)}`
        : "classify_roles_timeout",
    );
  }

  // Unwrap co-change pairs
  let coChangePairs: CoChangePair[] = [];
  if (coChangeResult.status === "fulfilled" && !isTimeout(coChangeResult.value)) {
    coChangePairs = coChangeResult.value.pairs.map((p) => ({
      file_a: p.file_a,
      file_b: p.file_b,
      jaccard: p.jaccard,
    }));
  } else {
    degradedReasons.push(
      coChangeResult.status === "rejected"
        ? `cochange_error: ${coChangeResult.reason instanceof Error ? coChangeResult.reason.message : String(coChangeResult.reason)}`
        : "cochange_timeout",
    );
  }

  // Unwrap fan-in/fan-out (used for cross-edge extraction)
  if (fanResult.status === "rejected" || isTimeout(fanResult.value)) {
    degradedReasons.push(
      fanResult.status === "rejected"
        ? `fanin_error: ${fanResult.reason instanceof Error ? fanResult.reason.message : String(fanResult.reason)}`
        : "fanin_timeout",
    );
  }

  // Unwrap hotspots
  let fileHotspots: FileHotspot[] = [];
  if (hotspotsResult.status === "fulfilled" && !isTimeout(hotspotsResult.value)) {
    fileHotspots = hotspotsResult.value.hotspots.slice(0, 20).map((h) => ({
      file: h.file,
      commits: h.commits,
      hotspot_score: h.hotspot_score,
    }));
  } else {
    degradedReasons.push(
      hotspotsResult.status === "rejected"
        ? `hotspots_error: ${hotspotsResult.reason instanceof Error ? hotspotsResult.reason.message : String(hotspotsResult.reason)}`
        : "hotspots_timeout",
    );
  }

  // Unwrap project (framework info)
  let frameworkInfo: FrameworkInfo | null = null;
  if (projectResult.status === "fulfilled" && !isTimeout(projectResult.value)) {
    const fw = projectResult.value.stack?.framework;
    if (fw) {
      frameworkInfo = { name: fw, details: `Primary framework detected: ${fw}.` };
    }
  } else {
    degradedReasons.push(
      projectResult.status === "rejected"
        ? `project_error: ${projectResult.reason instanceof Error ? projectResult.reason.message : String(projectResult.reason)}`
        : "project_timeout",
    );
  }

  // Compute surprise scores
  const globalDensity = index.files.length > 0 ? crossEdges.length / (index.files.length * index.files.length) : 0;
  const surprises = computeSurpriseScores(communities, crossEdges, coChangePairs, globalDensity);

  // Build community page data
  const communityPages: PageInfo[] = communities.map((comm) => {
    const slug = toSlug(comm.name);
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
    const content = generateCommunityPage(data);
    return { slug, title: comm.name, type: "community" as const, file: `${slug}.md`, content };
  });

  // Hubs page
  const hubsContent = generateHubsPage(hubSymbols);
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

  // Collect all content pages (excluding index) for index generation
  const contentPages: PageInfo[] = [
    ...communityPages,
    hubsPage,
    surprisesPage,
    hotspotsPage,
    ...frameworkPages,
  ];

  // Index page
  const indexContent = generateIndexPage(
    contentPages.map((p) => ({ slug: p.slug, title: p.title, type: p.type })),
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

  // Build manifest
  const indexHash = computeIndexHash(index.files);
  const manifestOptions: Parameters<typeof buildWikiManifest>[0] = {
    index_hash: indexHash,
    git_commit: "unknown",
    pages: resolvedPageInfos,
    communities,
    degradedReasons,
  };
  if (oldManifest !== undefined) {
    manifestOptions.oldManifest = oldManifest as WikiManifest;
  }
  const manifest = buildWikiManifest(manifestOptions);

  // Write pages
  for (const page of resolvedPageInfos) {
    await writeFile(join(outputDir, page.file), page.content, "utf-8");
  }

  // Stale page cleanup: delete .md files from a previous run that are no longer generated
  const existingFiles = await readdir(outputDir);
  const newFiles = new Set(resolvedPageInfos.map((p) => p.file));
  newFiles.add("wiki-manifest.json");
  newFiles.add("wiki-manifest.json.tmp");
  newFiles.add(".wiki-lock");
  for (const f of existingFiles) {
    if (f.endsWith(".md") && !newFiles.has(f)) {
      await unlink(join(outputDir, f));
    }
  }

  // Atomic manifest write: write to .tmp then rename
  const manifestPath = join(outputDir, "wiki-manifest.json");
  const tmpPath = manifestPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  await rename(tmpPath, manifestPath);

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
