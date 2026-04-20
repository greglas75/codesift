/**
 * Wiki v2 module builder — assembles ProjectOverview, ModuleMetadata[], and
 * the v2 WikiManifest writer. Framework-aware description cascade lives in
 * wiki-cascade.ts; raw parsers and key-dep selector in wiki-overview-sources.ts.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CodeIndex, CodeSymbol } from "../types.js";
import type { ProjectProfile } from "./project-tools.js";
import type { CommunityInfo } from "./wiki-surprise.js";
import type { ImportEdge } from "../utils/import-graph.js";
import type { RankedHubSymbol } from "./wiki-hub-ranker.js";
import {
  isShallowClone,
  parseGoMod,
  parsePyprojectToml,
  parseCargoToml,
  selectKeyDependencies,
} from "./wiki-overview-sources.js";
import type {
  ProjectOverview,
  ModuleMetadata,
  KeyExport,
  ModuleRole,
  WikiManifestV2,
  WikiManifest,
  DependencySummary,
} from "./wiki-manifest.js";
import {
  buildUniqueSlugs,
  buildFileToCommunityMap,
  type PageInfo,
} from "./wiki-manifest.js";
import type { FileHotspot } from "./wiki-page-generators.js";

interface GitHealthLike {
  total_commits?: number | null;
  contributors?: number | null;
}

/**
 * Build a ProjectOverview from the analyzeProject result and the code index.
 * Emits `_degraded` as a side-channel when git history is shallow/missing; the
 * orchestrator strips it and pushes to `degraded_reasons`.
 */
export function buildProjectOverview(
  projectResult: ProjectProfile,
  codeIndex: CodeIndex,
): ProjectOverview & { _degraded?: string } {
  const ident = projectResult.identity;
  const stack = projectResult.stack;
  const name = ident?.project_name ?? basename(codeIndex.root);
  const project_type = ident?.project_type ?? "single";
  const workspaces = stack?.monorepo?.workspaces ?? [];
  const scripts = readScripts(codeIndex.root);
  const fallbackName = nonJsFallbackName(codeIndex.root);

  const dependencies = selectKeyDependencies(projectResult);
  mergeNonJsDeps(dependencies, codeIndex.root);

  const gh = (projectResult as unknown as { git_health?: GitHealthLike | null }).git_health ?? null;
  const shallow = isShallowClone(codeIndex.root);
  const totalCommits = shallow || gh === null ? null : (gh?.total_commits ?? null);
  const contributors = shallow || gh === null ? null : (gh?.contributors ?? null);

  const overview: ProjectOverview & { _degraded?: string } = {
    name: name ?? fallbackName ?? "unknown",
    git_remote: ident?.git_remote ?? null,
    project_type,
    stack: {
      language: stack?.language ?? inferLanguage(codeIndex.root) ?? "unknown",
      language_version: stack?.language_version ?? null,
      framework: stack?.framework ?? null,
      framework_version: stack?.framework_version ?? null,
      test_runner: stack?.test_runner ?? null,
      package_manager: stack?.package_manager ?? null,
      build_tool: stack?.build_tool ?? null,
    },
    scripts,
    entry_points: projectResult.dependency_graph?.entry_points ?? [],
    workspaces,
    dependencies,
    known_gotchas: (projectResult.known_gotchas?.auto_detected ?? []).map((g) => ({
      gotcha: g.gotcha,
      severity: g.severity,
    })),
    stats: {
      total_files: codeIndex.file_count,
      total_commits: totalCommits,
      contributors,
    },
  };
  if (shallow || gh === null) {
    overview._degraded = "shallow_clone_or_insufficient_history";
  }
  return overview;
}

function readScripts(root: string): Record<string, string> {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function nonJsFallbackName(root: string): string | null {
  try {
    const goMod = readFileSync(join(root, "go.mod"), "utf-8");
    const p = parseGoMod(goMod);
    if (p.name) return basename(p.name);
  } catch { /* no go.mod */ }
  try {
    const py = readFileSync(join(root, "pyproject.toml"), "utf-8");
    const p = parsePyprojectToml(py);
    if (p.name) return p.name;
  } catch { /* no pyproject */ }
  try {
    const cargo = readFileSync(join(root, "Cargo.toml"), "utf-8");
    const p = parseCargoToml(cargo);
    if (p.name) return p.name;
  } catch { /* no cargo */ }
  return null;
}

function mergeNonJsDeps(summary: DependencySummary, root: string): void {
  if (summary.key.length > 0) return;
  try {
    const py = readFileSync(join(root, "pyproject.toml"), "utf-8");
    const p = parsePyprojectToml(py);
    summary.prod_total = Math.max(summary.prod_total, p.deps.length);
    for (const name of p.deps.slice(0, 15)) {
      summary.key.push({ name, version: "", kind: "prod" });
    }
    return;
  } catch { /* skip */ }
  try {
    const goMod = readFileSync(join(root, "go.mod"), "utf-8");
    const p = parseGoMod(goMod);
    summary.prod_total = Math.max(summary.prod_total, p.deps.length);
    for (const name of p.deps.slice(0, 15)) {
      summary.key.push({ name, version: "", kind: "prod" });
    }
  } catch { /* skip */ }
}

function inferLanguage(root: string): string | null {
  try { readFileSync(join(root, "go.mod"), "utf-8"); return "Go"; } catch {}
  try { readFileSync(join(root, "pyproject.toml"), "utf-8"); return "Python"; } catch {}
  try { readFileSync(join(root, "Cargo.toml"), "utf-8"); return "Rust"; } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// ModuleMetadata assembly (cascade + per-community data)
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /\.test\.(ts|js|py|go)$|\.spec\.(ts|js)$|__tests__\//;

export function buildModuleMetadata(
  communities: CommunityInfo[],
  projectResult: ProjectProfile,
  codeIndex: CodeIndex,
  importEdges: ImportEdge[],
  fileHotspots: FileHotspot[],
  rankedHubs: RankedHubSymbol[], // reserved — future: per-community hub listing
): ModuleMetadata[] {
  void rankedHubs;
  const slugs = buildUniqueSlugs(communities);
  const fileToCommunity = buildFileToCommunityMap(communities, slugs);
  const hotspotFiles = new Set(fileHotspots.slice(0, 20).map((h) => h.file));
  const symbolsByFile = indexSymbolsByFile(codeIndex.symbols);
  const out: ModuleMetadata[] = [];

  for (const c of communities) {
    const slug = slugs.get(c.name)!;
    const isTestCommunity = c.files.length > 0 && c.files.every((f) => TEST_FILE_RE.test(f));
    const microModule = c.files.length < 4;
    const description = describeCommunity(c, projectResult, isTestCommunity, importEdges, fileToCommunity);
    const role: ModuleRole = isTestCommunity ? "tests"
      : microModule ? "micro-module"
      : inferRole(c, projectResult);
    const { key_exports, approximate } = collectKeyExports(c, symbolsByFile, importEdges);
    const has_hotspot = c.files.some((f) => hotspotFiles.has(f));
    const { depends_on, depended_by } = computeCommunityEdges(c, importEdges, fileToCommunity, slug);
    const module: ModuleMetadata = {
      slug,
      name: c.name,
      description,
      role,
      files: c.files.length,
      cohesion: (c as unknown as { cohesion?: number }).cohesion ?? 0,
      key_exports,
      depends_on,
      depended_by,
      has_hotspot,
    };
    if (approximate) module.key_exports_approximate = true;
    out.push(module);
  }
  return out;
}

function indexSymbolsByFile(symbols: CodeSymbol[]): Map<string, CodeSymbol[]> {
  const map = new Map<string, CodeSymbol[]>();
  for (const s of symbols) {
    const arr = map.get(s.file);
    if (arr) arr.push(s); else map.set(s.file, [s]);
  }
  return map;
}

function collectKeyExports(
  c: CommunityInfo,
  symbolsByFile: Map<string, CodeSymbol[]>,
  importEdges: ImportEdge[],
): { key_exports: KeyExport[]; approximate: boolean } {
  const candidates: CodeSymbol[] = [];
  for (const f of c.files) {
    for (const s of symbolsByFile.get(f) ?? []) {
      if (s.is_exported === true) candidates.push(s);
    }
  }
  if (candidates.length > 0) {
    const byFanIn = rankByExternalImport(candidates, importEdges, c.files);
    return {
      key_exports: byFanIn.slice(0, 5).map(toKeyExport),
      approximate: false,
    };
  }
  // Fallback: community files imported from outside → surface first symbol per file
  const externallyImported = new Set<string>();
  const fileSet = new Set(c.files);
  for (const e of importEdges) {
    if (fileSet.has(e.to) && !fileSet.has(e.from)) externallyImported.add(e.to);
  }
  const approx: CodeSymbol[] = [];
  for (const f of externallyImported) {
    const syms = symbolsByFile.get(f) ?? [];
    const first = syms.find((s) => EXPORT_KINDS.has(s.kind));
    if (first) approx.push(first);
  }
  return {
    key_exports: approx.slice(0, 5).map(toKeyExport),
    approximate: approx.length > 0,
  };
}

const EXPORT_KINDS = new Set(["function", "class", "interface", "type", "component", "hook"]);

function toKeyExport(s: CodeSymbol): KeyExport {
  const kind = EXPORT_KINDS.has(s.kind) ? (s.kind as KeyExport["kind"]) : "function";
  const out: KeyExport = { name: s.name, kind, file: s.file };
  if (s.signature) out.signature = s.signature;
  return out;
}

function rankByExternalImport(
  syms: CodeSymbol[],
  edges: ImportEdge[],
  communityFiles: string[],
): CodeSymbol[] {
  const fileSet = new Set(communityFiles);
  const externalImporters = new Map<string, number>();
  for (const e of edges) {
    if (fileSet.has(e.to) && !fileSet.has(e.from)) {
      externalImporters.set(e.to, (externalImporters.get(e.to) ?? 0) + 1);
    }
  }
  return [...syms].sort((a, b) => (externalImporters.get(b.file) ?? 0) - (externalImporters.get(a.file) ?? 0));
}

function computeCommunityEdges(
  c: CommunityInfo,
  edges: ImportEdge[],
  fileToCommunity: Record<string, string>,
  ownSlug: string,
): { depends_on: string[]; depended_by: string[] } {
  const fileSet = new Set(c.files);
  const dependsOn = new Set<string>();
  const dependedBy = new Set<string>();
  for (const e of edges) {
    const fromSlug = fileToCommunity[e.from];
    const toSlug = fileToCommunity[e.to];
    if (fromSlug === ownSlug && toSlug && toSlug !== ownSlug) dependsOn.add(toSlug);
    if (toSlug === ownSlug && fromSlug && fromSlug !== ownSlug) dependedBy.add(fromSlug);
    // fileSet referenced to preserve intent
    void fileSet;
  }
  return {
    depends_on: [...dependsOn].sort(),
    depended_by: [...dependedBy].sort(),
  };
}

function inferRole(c: CommunityInfo, projectResult: ProjectProfile): ModuleRole {
  const dir = commonDirPrefix(c.files);
  if (/routes|controller|handlers?/.test(dir)) return "framework-routes";
  if (/components?|ui|views/.test(dir)) return "framework-components";
  if (/utils?|helpers?|lib/.test(dir)) return "utilities";
  if (/parser|extract/.test(dir)) return "parsers";
  if (/storage|db|repository/.test(dir)) return "storage";
  if (/search|query|index/.test(dir)) return "search";
  if (/cli|bin/.test(dir)) return "cli";
  if (projectResult.stack?.framework) return "framework-tools";
  return "core-library";
}

function commonDirPrefix(files: string[]): string {
  if (files.length === 0) return "";
  const parts = files[0]!.split("/");
  for (const f of files.slice(1)) {
    const fp = f.split("/");
    while (parts.length > 0 && parts[0] !== fp[0]) parts.shift();
    if (parts.length === 0) break;
  }
  return parts.join("/");
}

// Description cascade: framework → dep-lookup → file-pattern/keyword
function describeCommunity(
  c: CommunityInfo,
  projectResult: ProjectProfile,
  isTestCommunity: boolean,
  importEdges: ImportEdge[],
  fileToCommunity: Record<string, string>,
): string {
  if (isTestCommunity) return describeTestCommunity(c, importEdges, fileToCommunity);
  try {
    const lvl1 = describeViaFramework(c, projectResult);
    if (lvl1) return lvl1;
  } catch { /* advance */ }
  try {
    const lvl2 = describeViaDependencyLookup(c, projectResult);
    if (lvl2) return lvl2;
  } catch { /* advance */ }
  return describeViaFilePatterns(c);
}

function describeTestCommunity(
  c: CommunityInfo,
  importEdges: ImportEdge[],
  fileToCommunity: Record<string, string>,
): string {
  const fileSet = new Set(c.files);
  const outgoing = new Map<string, number>();
  for (const e of importEdges) {
    if (!fileSet.has(e.from)) continue;
    const target = fileToCommunity[e.to];
    if (target) outgoing.set(target, (outgoing.get(target) ?? 0) + 1);
  }
  const top = [...outgoing.entries()].sort((a, b) => b[1] - a[1])[0];
  const target = top?.[0] ?? "this project";
  return `Test suite for ${target}`;
}

function describeViaFramework(c: CommunityInfo, p: ProjectProfile): string | null {
  const dir = commonDirPrefix(c.files);
  const fw = p.stack?.framework;
  if (!fw) return null;
  if (/controller/.test(dir) && fw.toLowerCase().includes("nest")) {
    return `NestJS controllers — ${c.files.length} files handling HTTP routes.`;
  }
  if (/pages|app/.test(dir) && fw.toLowerCase().includes("next")) {
    return `Next.js routes and layouts — ${c.files.length} files.`;
  }
  if (/routes|handlers?/.test(dir) && fw.toLowerCase().includes("hono")) {
    return `Hono route handlers — ${c.files.length} files.`;
  }
  if (/components?/.test(dir) && fw.toLowerCase().includes("react")) {
    return `React components — ${c.files.length} files.`;
  }
  return null;
}

const DEP_ROLES: Record<string, string> = {
  prisma: "Prisma data access", "@prisma/client": "Prisma client integration",
  pg: "Postgres data access", mongoose: "MongoDB data access",
  "drizzle-orm": "Drizzle ORM data access",
  redis: "Redis integration", ioredis: "Redis integration",
  zod: "Zod validation schemas",
  "@tanstack/react-query": "Data fetching via TanStack Query",
  "graphql": "GraphQL integration",
};

function describeViaDependencyLookup(c: CommunityInfo, p: ProjectProfile): string | null {
  const kv = (p as unknown as { dependency_health?: { key_versions?: Record<string, string> } }).dependency_health?.key_versions ?? {};
  for (const pkg of Object.keys(kv)) {
    if (pkg in DEP_ROLES && pkg_keywordsInFiles(pkg, c.files)) {
      return `${DEP_ROLES[pkg]} — ${c.files.length} files.`;
    }
  }
  return null;
}

function pkg_keywordsInFiles(pkg: string, files: string[]): boolean {
  const base = pkg.replace(/^@/, "").split("/")[0]!.toLowerCase();
  return files.some((f) => f.toLowerCase().includes(base));
}

function describeViaFilePatterns(c: CommunityInfo): string {
  const dir = commonDirPrefix(c.files);
  if (/utils?|helpers?/.test(dir)) return `Utilities — ${c.files.length} helper files under ${dir || "this module"}.`;
  if (/parser|extractor/.test(dir)) return `Parsers and extractors — ${c.files.length} files under ${dir}.`;
  if (/storage/.test(dir)) return `Storage layer — ${c.files.length} files.`;
  if (/tools?/.test(dir)) return `Tooling — ${c.files.length} files under ${dir}.`;
  return `Module of ${c.files.length} files${dir ? ` under ${dir}` : ""}.`;
}

// ---------------------------------------------------------------------------
// Manifest writers
// ---------------------------------------------------------------------------

export interface BuildWikiManifestV2Options {
  index_hash: string;
  git_commit: string;
  pages: PageInfo[];
  communities: CommunityInfo[];
  project: ProjectOverview;
  modules: ModuleMetadata[];
  oldManifest?: WikiManifest | WikiManifestV2;
  degradedReasons?: string[];
  modules_truncated?: boolean;
  truncation_reason?: "module_count_cap" | "token_budget";
}

export function buildWikiManifestV2(options: BuildWikiManifestV2Options): WikiManifestV2 {
  const {
    index_hash, git_commit, pages, communities, project, modules,
    oldManifest, degradedReasons, modules_truncated, truncation_reason,
  } = options;
  const file_to_community = buildFileToCommunityMap(communities);
  const token_estimates: Record<string, number> = {};
  const CHARS_PER_TOKEN = 4;
  for (const p of pages) token_estimates[p.slug] = Math.ceil(p.content.length / CHARS_PER_TOKEN);
  const slug_redirects: Record<string, string> = {
    ...((oldManifest as WikiManifest)?.slug_redirects ?? {}),
  };
  const linkRe = /\[\[([^\]]+)\]\]/g;
  const builtPages = pages.map((p) => {
    const outbound_links: string[] = [];
    linkRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(p.content)) !== null) {
      if (m[1] !== undefined) outbound_links.push(m[1]);
    }
    return { slug: p.slug, title: p.title, type: p.type, file: p.file, outbound_links };
  });
  const degraded = (degradedReasons?.length ?? 0) > 0;
  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    index_hash,
    git_commit,
    project,
    modules,
    pages: builtPages,
    slug_redirects,
    token_estimates,
    file_to_community,
    degraded,
    ...(degraded ? { degraded_reasons: degradedReasons } : {}),
    ...(modules_truncated ? { modules_truncated: true } : {}),
    ...(truncation_reason ? { truncation_reason } : {}),
  };
}

/** V1 writer — preserved for rollback (CODESIFT_WIKI_V1=1). Same shape as
 *  the legacy buildWikiManifest that used to live in wiki-manifest.ts. */
export interface BuildWikiManifestV1Options {
  index_hash: string;
  git_commit: string;
  pages: PageInfo[];
  communities: CommunityInfo[];
  oldManifest?: WikiManifest;
  degradedReasons?: string[];
}

export function buildWikiManifestV1(options: BuildWikiManifestV1Options): WikiManifest {
  const { index_hash, git_commit, pages, communities, oldManifest, degradedReasons } = options;
  const file_to_community = buildFileToCommunityMap(communities);
  const token_estimates: Record<string, number> = {};
  const CHARS_PER_TOKEN = 4;
  for (const p of pages) token_estimates[p.slug] = Math.ceil(p.content.length / CHARS_PER_TOKEN);
  const slug_redirects: Record<string, string> = { ...(oldManifest?.slug_redirects ?? {}) };
  const linkRe = /\[\[([^\]]+)\]\]/g;
  const builtPages = pages.map((p) => {
    const outbound_links: string[] = [];
    linkRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(p.content)) !== null) {
      if (m[1] !== undefined) outbound_links.push(m[1]);
    }
    return { slug: p.slug, title: p.title, type: p.type, file: p.file, outbound_links };
  });
  const degraded = (degradedReasons?.length ?? 0) > 0;
  return {
    generated_at: new Date().toISOString(),
    index_hash,
    git_commit,
    pages: builtPages,
    slug_redirects,
    token_estimates,
    file_to_community,
    degraded,
    ...(degraded ? { degraded_reasons: degradedReasons } : {}),
  };
}
