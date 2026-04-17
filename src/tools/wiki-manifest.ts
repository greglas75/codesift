import type { CommunityInfo } from "./wiki-surprise.js";

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
export function buildUniqueSlugs(
  communities: readonly { name: string }[],
): Map<string, string> {
  const nameToSlug = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const c of communities) {
    const base = toSlug(c.name) || "community";
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
