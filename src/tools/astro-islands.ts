/**
 * Astro island analysis tools.
 *
 * - astroAnalyzeIslands: scan indexed .astro files for client/server islands,
 *   group by directive and framework, flag common warnings.
 * - (Task 11 will add astroHydrationAudit here)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { parseAstroTemplate, type Island } from "../parser/astro-template.js";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// 10. astro_analyze_islands
// ---------------------------------------------------------------------------

export interface ServerIsland {
  file: string;
  line: number;
  component: string;
  has_fallback: boolean;
}

export interface AnalyzeIslandsResult {
  islands: Island[];
  summary: {
    total_islands: number;
    by_directive: Record<string, number>;
    by_framework: Record<string, number>;
    warnings: string[];
  };
  server_islands: ServerIsland[];
}

/**
 * Build a frontmatter import map from the raw .astro source.
 * Mirrors the logic in extractors/astro.ts.
 */
function buildImportMap(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  const fmMatch = source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!fmMatch) return imports;
  const fm = fmMatch[1]!;

  // default imports: import Foo from '...'
  const defaultRe = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = defaultRe.exec(fm)) !== null) {
    imports.set(m[1]!, m[2]!);
  }
  // named imports: import { X, Y as Z } from '...'
  const namedRe = /import\s+(?:\w+\s*,\s*)?\{\s*([^}]+)\}\s*from\s+["']([^"']+)["']/g;
  while ((m = namedRe.exec(fm)) !== null) {
    const names = m[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
    for (const n of names) if (n) imports.set(n, m[2]!);
  }
  return imports;
}

/**
 * Scan all indexed `.astro` files for interactive islands and server-deferred
 * components. Returns structured data with per-directive and per-framework
 * breakdowns plus common warnings.
 */
export async function astroAnalyzeIslands(args: {
  repo?: string;
  path_prefix?: string;
  include_recommendations?: boolean;
}): Promise<AnalyzeIslandsResult> {
  const repoName = args.repo ?? "";
  const index = await getCodeIndex(repoName);
  if (!index) {
    return {
      islands: [],
      summary: { total_islands: 0, by_directive: {}, by_framework: {}, warnings: [] },
      server_islands: [],
    };
  }

  return analyzeIslandsFromIndex(index, args.path_prefix);
}

/**
 * Core logic, separated for testability with a synthetic CodeIndex.
 */
export function analyzeIslandsFromIndex(
  index: CodeIndex,
  pathPrefix?: string,
): AnalyzeIslandsResult {
  const astroFiles = index.files.filter((f) => {
    if (f.language !== "astro") return false;
    if (pathPrefix && !f.path.startsWith(pathPrefix)) return false;
    return true;
  });

  const allIslands: Island[] = [];
  const serverIslands: ServerIsland[] = [];

  for (const file of astroFiles) {
    const absPath = join(index.root, file.path);
    let source: string;
    try {
      source = readFileSync(absPath, "utf-8");
    } catch {
      continue; // file may have been deleted since indexing
    }

    const imports = buildImportMap(source);
    const result = parseAstroTemplate(source, imports);

    for (const island of result.islands) {
      // Annotate island with the file it came from (stored in resolves_to_file is for the import target)
      const annotated: Island & { file?: string } = { ...island, file: file.path };

      if (island.directive === "server:defer") {
        // Check if this component tag has content (fallback) by looking at source
        const hasFallback = checkServerFallback(source, island);
        serverIslands.push({
          file: file.path,
          line: island.line,
          component: island.component_name,
          has_fallback: hasFallback,
        });
      } else {
        allIslands.push(annotated as Island);
      }
    }
  }

  // Build summary
  const byDirective: Record<string, number> = {};
  const byFramework: Record<string, number> = {};

  for (const island of allIslands) {
    byDirective[island.directive] = (byDirective[island.directive] ?? 0) + 1;
    const fw = island.framework_hint ?? "unknown";
    byFramework[fw] = (byFramework[fw] ?? 0) + 1;
  }

  const warnings = generateWarnings(allIslands, serverIslands);

  return {
    islands: allIslands,
    summary: {
      total_islands: allIslands.length,
      by_directive: byDirective,
      by_framework: byFramework,
      warnings,
    },
    server_islands: serverIslands,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkServerFallback(source: string, island: Island): boolean {
  // Simple heuristic: check if the component tag is NOT self-closing
  const lines = source.split("\n");
  const lineIdx = island.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return false;
  const line = lines[lineIdx]!;
  // Self-closing tags like <Foo server:defer /> have no fallback
  if (/\/\s*>/.test(line)) return false;
  // Otherwise assume it has children (fallback content)
  return true;
}

function generateWarnings(islands: Island[], serverIslands: ServerIsland[]): string[] {
  const warnings: string[] = [];

  // Warn if many components use client:load (eager hydration)
  const loadCount = islands.filter((i) => i.directive === "client:load").length;
  if (loadCount >= 5) {
    warnings.push(
      `${loadCount} components use client:load — consider client:idle or client:visible for below-fold content`,
    );
  }

  // Warn about server islands without fallback
  const noFallback = serverIslands.filter((s) => !s.has_fallback);
  if (noFallback.length > 0) {
    warnings.push(
      `${noFallback.length} server:defer component(s) lack fallback content`,
    );
  }

  return warnings;
}
