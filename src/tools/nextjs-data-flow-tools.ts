/**
 * Next.js data flow analyzer (T6).
 *
 * Walks `app/**\/page.{tsx,jsx}` files for `fetch()`, `cookies()`, `headers()`
 * calls (via the shared `extractFetchCalls` helper) and classifies fetch
 * patterns as waterfall vs parallel, plus cache strategy. Returns per-page
 * data flow entries with aggregate counts.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  deriveUrlPath,
  discoverWorkspaces,
  extractFetchCalls,
  type FetchCall,
} from "../utils/nextjs.js";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheStrategy = "cached" | "no-cache" | "default" | string;

export interface FetchAnalysis {
  fetches: FetchCall[];
  waterfall_pairs: Array<{ first: number; second: number }>;
  has_opt_out: boolean;
}

export interface DataFlowEntry {
  url_path: string;
  file: string;
  fetches: FetchCall[];
  waterfall_count: number;
  cache_distribution: Record<string, number>;
}

export interface NextjsDataFlowResult {
  entries: DataFlowEntry[];
  total_pages: number;
  total_waterfalls: number;
  cache_summary: Record<string, number>;
  workspaces_scanned: string[];
  parse_failures: string[];
  scan_errors: string[];
  limitations: string[];
}

export interface NextjsDataFlowOptions {
  workspace?: string | undefined;
  url_path?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function classifyFetches(fetches: FetchCall[]): FetchAnalysis {
  const waterfall_pairs: Array<{ first: number; second: number }> = [];
  let has_opt_out = false;
  for (let i = 0; i < fetches.length; i++) {
    const cur = fetches[i]!;
    if (cur.isSequential) {
      // Find the previous fetch that triggered this
      const prev = i > 0 ? fetches[i - 1] : null;
      if (prev) {
        waterfall_pairs.push({ first: prev.line, second: cur.line });
      }
    }
  }
  return { fetches, waterfall_pairs, has_opt_out };
}

export function classifyCacheStrategy(fetch: FetchCall): CacheStrategy {
  if (fetch.callee !== "fetch") return "default";
  const opt = fetch.cacheOption;
  if (!opt) return "default";
  if (opt === "no-store") return "no-cache";
  if (opt === "force-cache") return "cached";
  if (opt.startsWith("isr-")) return opt;
  return opt;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const PAGE_FILENAME_RE = /(^|\/)page\.(tsx|jsx|ts|js)$/;
const PAGE_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;

export async function nextjsDataFlow(
  repo: string,
  options?: NextjsDataFlowOptions,
): Promise<NextjsDataFlowResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_data_flow")) {
    throw new Error("nextjs_data_flow is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const entries: DataFlowEntry[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);
    const candidates: string[] = [];
    for (const dir of ["app", "src/app"]) {
      const fullDir = join(workspace, dir);
      try {
        const walked = await walkDirectory(fullDir, {
          followSymlinks: true,
          fileFilter: (ext) => PAGE_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        for (const f of walked) {
          if (PAGE_FILENAME_RE.test(f)) candidates.push(f);
        }
      } catch (err) {
        scan_errors.push(`${fullDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (let i = 0; i < candidates.length; i += PARSE_CONCURRENCY) {
      const chunk = candidates.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (filePath) => {
          const rel = relative(projectRoot, filePath);
          try {
            const source = await readFile(filePath, "utf8");
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return null;
            }
            const fetches = extractFetchCalls(tree, source);
            const analysis = classifyFetches(fetches);
            const cache_distribution: Record<string, number> = {};
            for (const f of fetches) {
              const strategy = classifyCacheStrategy(f);
              cache_distribution[strategy] = (cache_distribution[strategy] ?? 0) + 1;
            }
            const url_path = deriveUrlPath(rel, "app");
            const entry: DataFlowEntry = {
              url_path,
              file: rel,
              fetches,
              waterfall_count: analysis.waterfall_pairs.length,
              cache_distribution,
            };
            return entry;
          } catch (err) {
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const r of results) if (r) entries.push(r);
    }
  }

  // Optional URL path filter
  const filtered = options?.url_path
    ? entries.filter((e) => e.url_path === options.url_path)
    : entries;

  let total_waterfalls = 0;
  const cache_summary: Record<string, number> = {};
  for (const e of filtered) {
    total_waterfalls += e.waterfall_count;
    for (const [k, v] of Object.entries(e.cache_distribution)) {
      cache_summary[k] = (cache_summary[k] ?? 0) + v;
    }
  }

  return {
    entries: filtered,
    total_pages: filtered.length,
    total_waterfalls,
    cache_summary,
    workspaces_scanned,
    parse_failures,
    scan_errors,
    limitations: [
      "waterfall detection limited to same-scope sequential awaits",
      "Promise.all parallel detection requires identifier match heuristic",
    ],
  };
}
