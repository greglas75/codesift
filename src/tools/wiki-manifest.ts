import type { CommunityInfo } from "./wiki-surprise.js";

export interface LensData {
  communities: Array<{ name: string; slug: string; fileCount: number; cohesion: number }>;
  edges: Array<{ from: number; to: number; weight: number }>;
}

export interface WikiManifest {
  generated_at: string;
  index_hash: string;
  git_commit: string;
  pages: Array<{
    slug: string;
    title: string;
    type: "index" | "community" | "hubs" | "surprises" | "hotspots" | "framework";
    file: string;
    outbound_links: string[];
  }>;
  slug_redirects: Record<string, string>;
  token_estimates: Record<string, number>;
  file_to_community: Record<string, string>;
  degraded: boolean;
  degraded_reasons?: string[];
  lens_data?: LensData;
}

export type ModuleRole =
  | "framework-tools" | "framework-routes" | "framework-components"
  | "core-library" | "data-access" | "utilities" | "parsers"
  | "storage" | "search" | "cli" | "tests" | "scripts"
  | "micro-module" | "unknown";

export interface KeyExport {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "component" | "hook" | "default_export";
  file: string;
  signature?: string;
}

export interface ModuleMetadata {
  slug: string;
  name: string;
  description: string;
  role: ModuleRole;
  files: number;
  cohesion: number;
  key_exports: KeyExport[];
  depends_on: string[];
  depended_by: string[];
  has_hotspot: boolean;
  workspace?: string;
  key_exports_approximate?: boolean;
}

export interface DependencySummary {
  prod_total: number;
  dev_total: number;
  key: Array<{ name: string; version: string; kind: "prod" | "dev" }>;
}

export interface ProjectOverview {
  name: string;
  git_remote: string | null;
  project_type: "monorepo" | "single";
  stack: {
    language: string;
    language_version: string | null;
    framework: string | null;
    framework_version: string | null;
    test_runner: string | null;
    package_manager: string | null;
    build_tool: string | null;
  };
  scripts: Record<string, string>;
  entry_points: string[];
  workspaces: string[];
  dependencies: DependencySummary;
  known_gotchas: { gotcha: string; severity: "high" | "medium" | "low" }[];
  stats: {
    total_files: number;
    total_commits: number | null;
    contributors: number | null;
  };
}

export interface WikiManifestV2 {
  schema_version: 2;
  generated_at: string;
  index_hash: string;
  git_commit: string;
  project: ProjectOverview;
  modules: ModuleMetadata[];
  pages: WikiManifest["pages"];
  slug_redirects: Record<string, string>;
  token_estimates: Record<string, number>;
  file_to_community: Record<string, string>;
  lens_data?: LensData;
  degraded: boolean;
  degraded_reasons?: string[];
  modules_truncated?: boolean;
  truncation_reason?: "module_count_cap" | "token_budget";
}

export interface PageInfo {
  slug: string;
  title: string;
  type: WikiManifest["pages"][number]["type"];
  file: string;
  content: string; // used for token estimation and link extraction
}

const CHARS_PER_TOKEN = 4;

/** Converts a community name to a URL-safe kebab-case slug. */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Builds a collision-free `name -> slug` map. Duplicates are disambiguated with
 * a numeric suffix (`-2`, `-3`, …) in iteration order. Empty-slug names fall
 * back to the literal `community` base.
 */
export interface BuildUniqueSlugsOptions {
  monorepo?: boolean;
  workspaces?: string[];
}

export function buildUniqueSlugs(
  communities: readonly { name: string; files?: string[] }[],
  options?: BuildUniqueSlugsOptions,
): Map<string, string> {
  const nameToSlug = new Map<string, string>();
  const seen = new Map<string, number>();
  const useWorkspace = options?.monorepo === true && (options.workspaces?.length ?? 0) > 0;
  const workspaces = options?.workspaces ?? [];
  for (const c of communities) {
    let base = toSlug(c.name) || "community";
    if (useWorkspace && c.files && c.files.length > 0) {
      const ws = workspaces.find((w) => c.files!.some((f) => f.startsWith(w + "/") || f === w));
      if (ws) base = `${toSlug(ws)}-${base}`;
    }
    const count = seen.get(base) ?? 0;
    const slug = count === 0 ? base : `${base}-${count + 1}`;
    seen.set(base, count + 1);
    nameToSlug.set(c.name, slug);
  }
  return nameToSlug;
}

/**
 * Maps every file from every community to the community's kebab-case slug
 * using a collision-free slug map.
 */
export function buildFileToCommunityMap(
  communities: CommunityInfo[],
  slugMap: Map<string, string> = buildUniqueSlugs(communities),
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of communities) {
    const slug = slugMap.get(c.name) ?? toSlug(c.name);
    for (const f of c.files) {
      map[f] = slug;
    }
  }
  return map;
}

/**
 * Builds the wiki manifest — a single JSON artifact that describes every
 * generated wiki page and its metadata.
 */
export function buildWikiManifest(options: {
  index_hash: string;
  git_commit: string;
  pages: PageInfo[];
  communities: CommunityInfo[];
  oldManifest?: WikiManifest;
  degradedReasons?: string[];
}): WikiManifest {
  const { index_hash, git_commit, pages, communities, oldManifest, degradedReasons } =
    options;

  // File → community map
  const file_to_community = buildFileToCommunityMap(communities);

  // Token estimates: rough chars / 4 rounded up
  const token_estimates: Record<string, number> = {};
  for (const p of pages) {
    token_estimates[p.slug] = Math.ceil(p.content.length / CHARS_PER_TOKEN);
  }

  // Slug redirects: preserve whatever was in the old manifest
  const slug_redirects: Record<string, string> = {
    ...(oldManifest?.slug_redirects ?? {}),
  };

  // Extract [[slug]] outbound links from each page's content
  const linkRegex = /\[\[([^\]]+)\]\]/g;

  const builtPages = pages.map((p) => {
    const outbound_links: string[] = [];
    linkRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(p.content)) !== null) {
      const target = match[1];
      if (target !== undefined) {
        outbound_links.push(target);
      }
    }
    return {
      slug: p.slug,
      title: p.title,
      type: p.type,
      file: p.file,
      outbound_links,
    };
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
