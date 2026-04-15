/**
 * wiki-links.ts — Two-pass wiki link resolution with automatic backlink injection.
 *
 * Pass 1: Extract all [[slug]] forward links from each page.
 * Pass 2: Invert to backlinks, append ## Backlinks section to each page that has inbound links.
 */

export interface LinkResolutionResult {
  /** slug → content with backlinks section appended (where applicable) */
  resolvedPages: Map<string, string>;
  /** [[slug]] references whose target is not in knownSlugs */
  brokenLinks: Array<{ source: string; target: string }>;
}

const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Two-pass wiki link resolution with automatic backlink injection.
 *
 * @param pages     Map of slug → markdown content
 * @param knownSlugs Set of valid page slugs (for broken link detection)
 */
export function resolveWikiLinks(
  pages: Map<string, string>,
  knownSlugs: Set<string>,
): LinkResolutionResult {
  // Pass 1: extract forward links per page and collect broken links
  const forwardLinks = new Map<string, string[]>(); // srcSlug → destSlug[]
  const brokenLinks: Array<{ source: string; target: string }> = [];

  for (const [slug, content] of pages) {
    const targets: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(WIKI_LINK_RE.source, "g");

    while ((match = re.exec(content)) !== null) {
      const target = match[1]!;
      targets.push(target);
      if (!knownSlugs.has(target)) {
        brokenLinks.push({ source: slug, target });
      }
    }

    forwardLinks.set(slug, targets);
  }

  // Pass 2: invert forward links → backlinks map (destSlug → srcSlug[])
  const backlinks = new Map<string, string[]>(); // destSlug → srcSlug[]

  for (const [src, targets] of forwardLinks) {
    for (const dest of targets) {
      if (!backlinks.has(dest)) {
        backlinks.set(dest, []);
      }
      backlinks.get(dest)!.push(src);
    }
  }

  // Build resolvedPages: append ## Backlinks section where applicable
  const resolvedPages = new Map<string, string>();

  for (const [slug, content] of pages) {
    const inbound = backlinks.get(slug);
    if (inbound && inbound.length > 0) {
      const section =
        "\n\n## Backlinks\n\n" +
        inbound.map((s) => `- [[${s}]]`).join("\n") +
        "\n";
      resolvedPages.set(slug, content + section);
    } else {
      resolvedPages.set(slug, content);
    }
  }

  return { resolvedPages, brokenLinks };
}
