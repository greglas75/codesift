import { getCodeIndex } from "./index-tools.js";

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
  if (!index) return { indexed: false };

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
