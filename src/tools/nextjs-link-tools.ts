/**
 * Next.js link integrity checker (T5).
 *
 * Walks `app/**\/*.{tsx,jsx}` files for `<Link href>` JSX components and
 * `router.push/.replace` calls, then cross-references each href against the
 * route map (via `nextjsRouteMap`) to flag broken links. Template-literal
 * hrefs are bucketed as "unresolved" rather than guessed.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  discoverWorkspaces,
  extractLinkHrefs,
  type LinkRef,
} from "../utils/nextjs.js";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";
import { nextjsRouteMap } from "./nextjs-route-tools.js";

// Re-export LinkRef for downstream consumers (single source of truth: src/utils/nextjs.ts)
export type { LinkRef };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrokenLink {
  href: string;
  file: string;
  line: number;
  kind: LinkRef["kind"];
}

export interface UnresolvedLink {
  reason: "template_literal" | "non_literal";
  file: string;
  line: number;
  raw: string;
}

export interface LinkIntegrityResult {
  total_refs: number;
  resolved_count: number;
  broken_count: number;
  unresolved_count: number;
  broken: BrokenLink[];
  unresolved: UnresolvedLink[];
  workspaces_scanned: string[];
  parse_failures: string[];
  scan_errors: string[];
  limitations: string[];
}

export interface NextjsLinkIntegrityOptions {
  workspace?: string | undefined;
  max_files?: number | undefined;
}

// ---------------------------------------------------------------------------
// Route pattern matcher (Task 32)
// ---------------------------------------------------------------------------

/**
 * Convert a Next.js route pattern (`/products/[id]`, `/blog/[...slug]`,
 * `/shop/[[...slug]]`) into a regex matching literal href strings.
 */
function patternToRegex(pattern: string): RegExp {
  let s = pattern;
  // [[...slug]] → optional catch-all (any chars including empty)
  s = s.replace(/\[\[\.\.\.[\w]+\]\]/g, ".*");
  // [...slug] → required catch-all (one or more chars)
  s = s.replace(/\[\.\.\.[\w]+\]/g, ".+");
  // [id] → single segment
  s = s.replace(/\[[\w]+\]/g, "[^/]+");
  // Escape remaining regex metacharacters except / and the substituted patterns
  // (already substituted; safe to escape literal characters now)
  return new RegExp(`^${s}$`);
}

export function matchRoutePattern(href: string, routes: string[]): boolean {
  if (routes.length === 0) return false;
  // Strip query string + hash
  const path = href.split("?")[0]!.split("#")[0]!;
  for (const route of routes) {
    const re = patternToRegex(route);
    if (re.test(path)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Orchestrator (Task 33)
// ---------------------------------------------------------------------------

const COMPONENT_EXTS = new Set([".tsx", ".jsx"]);
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;

export async function nextjsLinkIntegrity(
  repo: string,
  options?: NextjsLinkIntegrityOptions,
): Promise<LinkIntegrityResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_link_integrity")) {
    throw new Error("nextjs_link_integrity is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  // Get the route map
  const routeMap = await nextjsRouteMap(repo, options?.workspace ? { workspace: options.workspace } : undefined);
  const knownRoutes = routeMap.routes
    .filter((r) => r.type === "page" || r.type === "route")
    .map((r) => r.url_path);

  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const broken: BrokenLink[] = [];
  const unresolved: UnresolvedLink[] = [];
  let total_refs = 0;
  let resolved_count = 0;
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);
    const candidates: string[] = [];
    for (const dir of ["app", "src/app", "pages", "src/pages"]) {
      const fullDir = join(workspace, dir);
      try {
        const walked = await walkDirectory(fullDir, {
          followSymlinks: true,
          fileFilter: (ext) => COMPONENT_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        candidates.push(...walked);
      } catch (err) {
        scan_errors.push(`${fullDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (let i = 0; i < candidates.length; i += PARSE_CONCURRENCY) {
      const chunk = candidates.slice(i, i + PARSE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (filePath) => {
          const rel = relative(projectRoot, filePath);
          try {
            const source = await readFile(filePath, "utf8");
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return;
            }
            const refs = extractLinkHrefs(tree, source);
            for (const ref of refs) {
              total_refs++;
              if (ref.isDynamic) {
                unresolved.push({
                  reason: "template_literal",
                  file: rel,
                  line: ref.line,
                  raw: ref.href,
                });
                continue;
              }
              if (matchRoutePattern(ref.href, knownRoutes)) {
                resolved_count++;
              } else {
                broken.push({
                  href: ref.href,
                  file: rel,
                  line: ref.line,
                  kind: ref.kind,
                });
              }
            }
          } catch (err) {
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    }
  }

  return {
    total_refs,
    resolved_count,
    broken_count: broken.length,
    unresolved_count: unresolved.length,
    broken,
    unresolved,
    workspaces_scanned,
    parse_failures,
    scan_errors,
    limitations: [
      "literal-only matching: template-literal hrefs bucketed as unresolved",
      "external links (http://, https://) and mailto: not validated",
    ],
  };
}
