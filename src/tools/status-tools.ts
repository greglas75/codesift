import { getCodeIndex } from "./index-tools.js";
import { loadConfig } from "../config.js";
import { resolveRegisteredRepoMeta } from "../storage/registry.js";
import { loadIndexOrStale } from "../storage/index-store.js";
import { EXTRACTOR_VERSIONS } from "./project-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexStatusResult {
  indexed: boolean;
  file_count?: number;
  symbol_count?: number;
  language_breakdown?: Record<string, number>;
  text_stub_languages?: string[];
  last_indexed?: string; // ISO date
  /** When the index file exists but its extractor_version drifted from the
   *  current bundled set. Distinct from "no index file at all" — agents need
   *  this signal to know that re-running index_folder will fix it, instead of
   *  assuming the repo was never indexed. */
  stale?: {
    reason: "extractor_version_mismatch";
    language: string;
    expected_version: string;
    actual_version: string;
    mismatch_detail?: string;
  };
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

const TEXT_STUB_LANGUAGES = new Set([
  "kotlin", "swift", "dart", "scala", "groovy",
  "elixir", "lua", "zig", "nim", "gradle", "sbt",
]);

export async function indexStatus(repo: string): Promise<IndexStatusResult> {
  // Status check should NOT block on freshness — telemetry showed p99=43s
  // because ensureIndexFresh triggers git-diff + reindex of changed files.
  // Stale-but-fast metadata is the right tradeoff for a status call.
  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) {
    // getCodeIndex returns null both for "no index file" and for stale-version
    // mismatches. Disambiguate by reading the index path directly: if the file
    // exists but extractor_version drifted, surface a structured stale signal
    // instead of a generic "not indexed". Agents acting on "not indexed" will
    // run index_folder, but agents acting on "stale" can be told the same fix
    // applies AND that some data is still on disk — useful for reasoning about
    // partial coverage during the rebuild.
    const stale = await detectStale(repo);
    if (stale) return { indexed: false, stale };
    return { indexed: false };
  }

  const languageBreakdown: Record<string, number> = {};
  const stubLangs = new Set<string>();

  for (const file of index.files) {
    languageBreakdown[file.language] = (languageBreakdown[file.language] ?? 0) + 1;
    if (TEXT_STUB_LANGUAGES.has(file.language)) {
      stubLangs.add(file.language);
    }
  }

  const result: IndexStatusResult = {
    indexed: true,
    file_count: index.file_count,
    symbol_count: index.symbol_count,
    language_breakdown: languageBreakdown,
    last_indexed: new Date(index.updated_at).toISOString(),
  };
  if (stubLangs.size > 0) result.text_stub_languages = [...stubLangs].sort();
  return result;
}

/** Probe the on-disk index for a repo and return stale info if the file exists
 *  but its `extractor_version` snapshot drifted. Returns null when no index file
 *  is registered for the repo (the genuine "never indexed" case). Uses
 *  `resolveRegisteredRepoMeta` so registry resolution stays aligned with `getCodeIndex`. */
async function detectStale(
  repo: string,
): Promise<IndexStatusResult["stale"] | null> {
  const config = loadConfig();
  let result: Awaited<ReturnType<typeof loadIndexOrStale>>;
  try {
    const resolved = await resolveRegisteredRepoMeta(config.registryPath, repo);
    if (!resolved) return null;
    result = await loadIndexOrStale(resolved.meta.index_path, { ...EXTRACTOR_VERSIONS });
  } catch {
    return null;
  }
  if (result?.status === "stale") {
    return {
      reason: "extractor_version_mismatch",
      language: result.language,
      expected_version: result.expected_version,
      actual_version: result.actual_version,
      ...(result.mismatch_detail ? { mismatch_detail: result.mismatch_detail } : {}),
    };
  }
  return null;
}
