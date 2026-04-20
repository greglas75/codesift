/**
 * plan-turn-tools.ts — Query parser + main handler for plan/turn routing.
 *
 * Parser (Task 6):
 *   - Normalisation (lowercase, trim, 1000-char cap)
 *   - Multi-intent split on "and / or / ; / &&" with surrounding whitespace
 *   - File ref extraction (extensions: ts/tsx/js/jsx/py/go/rs/php/kt/sql)
 *   - Symbol ref extraction (cross-referenced against index.symbols)
 *   - Vague detection (short query with no domain keywords)
 *
 * Handler (Task 7) — `planTurn`:
 *   1. Guards against missing index → returns structured error
 *   2. Parses query via parseQuery
 *   3. Checks negative evidence → returns STOP_AND_REPORT_GAP early
 *   4. Builds ranker context (usage freq, framework tools, embeddings)
 *   5. Runs rankTools per intent, merges results
 *   6. Dedups against session.queries (top-3 retained)
 *   7. Collects hidden tool names for reveal_required[]
 *   8. Populates metadata flags (stale_index, framework_mismatch, cold_start…)
 */

import { getCodeIndex } from "./index-tools.js";
import {
  getToolDefinitions,
  CORE_TOOL_NAMES,
  detectAutoLoadToolsCached,
} from "../register-tools.js";
import {
  rankTools,
  getToolEmbeddings,
  type ToolRankerContext,
  type ToolRecommendation,
} from "../search/tool-ranker.js";
import { getSessionState } from "../storage/session-state.js";
import { getUsageStats } from "../storage/usage-stats.js";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  original: string;
  normalized: string;     // lowercased, trimmed, capped at 1000 chars
  truncated: boolean;     // true if original.length > 1000
  intents: string[];      // split sub-queries (1 if no multi-intent)
  file_refs: string[];    // extracted file paths
  symbol_refs: string[];  // extracted symbol names (cross-ref'd against index.symbols)
  is_vague: boolean;      // length < 15 AND < 2 domain keywords
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAGUE_STOPWORDS = new Set([
  "help", "hi", "hello", "what", "how", "why", "please", "can", "could",
]);

const DOMAIN_KEYWORDS = new Set([
  "find", "search", "audit", "analyze", "trace", "review", "check",
  "show", "get", "list", "detect", "scan",
]);

const FILE_EXT_RE =
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/g;

// Identifiers: starts with letter or _, at least 3 chars total
const IDENT_RE = /\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g;

// Split only on whitespace-bounded and/or/;/&&
const MULTI_INTENT_RE = /\s+(?:and|or|;|&&)\s+/i;

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

export function parseQuery(raw: string, index: CodeIndex): ParsedQuery {
  const original = raw;
  const truncated = raw.length > 1000;
  const normalized = raw.slice(0, 1000).toLowerCase().trim();

  // Empty / whitespace-only input
  if (normalized.length === 0) {
    return {
      original,
      normalized,
      truncated,
      intents: [],
      file_refs: [],
      symbol_refs: [],
      is_vague: true,
    };
  }

  // Multi-intent split
  const intents = normalized.split(MULTI_INTENT_RE);

  // File references — run on the normalized text
  const file_refs = Array.from(
    new Set(normalized.match(FILE_EXT_RE) ?? []),
  );

  // Symbol references — extract identifiers from the original text (capped at
  // 1000 chars, pre-lowercase) to preserve camelCase names, then cross-reference
  // against the index symbol table using exact match.
  const symbolNames = new Set(index.symbols.map((s) => s.name));
  const rawCapped = raw.slice(0, 1000);
  const candidateTokens = Array.from(
    new Set(rawCapped.match(IDENT_RE) ?? []),
  );
  const symbol_refs = candidateTokens.filter((tok) => symbolNames.has(tok));

  // Vague detection
  const words = normalized.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const containsDomainKeyword = words.some((w) => DOMAIN_KEYWORDS.has(w));
  const allStopwords = words.every((w) => VAGUE_STOPWORDS.has(w));

  const is_vague =
    normalized.length < 15 &&
    wordCount < 3 &&
    (!containsDomainKeyword || allStopwords);

  return {
    original,
    normalized,
    truncated,
    intents,
    file_refs,
    symbol_refs,
    is_vague,
  };
}

// ---------------------------------------------------------------------------
// planTurn — main handler
// ---------------------------------------------------------------------------

export interface SymbolRecommendation {
  name: string;
  file: string;
  line: number;
  kind: string;
  score: number;
}

export interface FileRecommendation {
  path: string;
  score: number;
  reason: string;
}

export interface GapAnalysis {
  action: "STOP_AND_REPORT_GAP";
  prior_query: string;
  prior_result_count: number;
  suggestion: string;
}

export interface PlanTurnMetadata {
  intents_detected: number;
  bm25_candidates: number;
  embedding_available: boolean;
  session_queries_seen: number;
  duration_ms: number;
  truncated?: boolean;
  vague_query?: boolean;
  stale_index?: boolean;
  low_discrimination?: boolean;
  framework_mismatch?: boolean;
  cold_start?: boolean;
  unindexed?: boolean;
}

export interface PlanTurnResult {
  query: string;
  truncated: boolean;
  confidence: number;
  tools: ToolRecommendation[];
  symbols: SymbolRecommendation[];
  files: FileRecommendation[];
  reveal_required: string[];
  already_used: string[];
  gap_analysis?: GapAnalysis;
  framework_context?: string;
  metadata: PlanTurnMetadata;
}

// ---------------------------------------------------------------------------
// Module-scoped caches
// ---------------------------------------------------------------------------

let usageFreqCache: Map<string, number> | null = null;

/** Fetch usage frequency map (tool → call count). Cached per process. */
async function getUsageFrequency(): Promise<Map<string, number>> {
  if (usageFreqCache) return usageFreqCache;
  try {
    const stats = await getUsageStats();
    const map = new Map<string, number>();
    for (const t of stats.tools ?? []) {
      map.set(t.tool, t.total_calls ?? 0);
    }
    usageFreqCache = map;
    return map;
  } catch {
    return new Map();
  }
}

/** Test-only reset of module caches. */
export function _resetPlanTurnCaches(): void {
  usageFreqCache = null;
}

// ---------------------------------------------------------------------------
// Constants for merging / framework mismatch detection
// ---------------------------------------------------------------------------

const STALE_INDEX_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_TOOLS = 10;
const MAX_SYMBOLS = 20;
const MAX_FILES = 10;

/** Frameworks detectable via detectAutoLoadTools. If user mentions one but
 *  it's not in the detected framework tools, flag framework_mismatch. */
const KNOWN_FRAMEWORK_KEYWORDS: Record<string, string[]> = {
  react: ["react", "jsx", "tsx"],
  nextjs: ["next", "next.js", "nextjs"],
  astro: ["astro"],
  hono: ["hono"],
  php: ["php", "yii", "laravel", "symfony"],
  kotlin: ["kotlin", "compose", "android"],
  python: ["python", "django", "fastapi", "flask"],
};

// ---------------------------------------------------------------------------
// Helper: build an "unindexed" error result
// ---------------------------------------------------------------------------

function buildUnindexedResult(
  query: string,
  startedAt: number,
): PlanTurnResult {
  const indexFolderRec: ToolRecommendation = {
    name: "index_folder",
    confidence: 1.0,
    reasoning: "Repo is not indexed — run index_folder before any query tools",
    is_hidden: !CORE_TOOL_NAMES.has("index_folder"),
  };
  return {
    query,
    truncated: false,
    confidence: 1.0,
    tools: [indexFolderRec],
    symbols: [],
    files: [],
    reveal_required: indexFolderRec.is_hidden ? [indexFolderRec.name] : [],
    already_used: [],
    metadata: {
      intents_detected: 0,
      bm25_candidates: 0,
      embedding_available: false,
      session_queries_seen: 0,
      duration_ms: Date.now() - startedAt,
      unindexed: true,
      cold_start: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: merge tool recommendations across intents (max-confidence dedup)
// ---------------------------------------------------------------------------

function mergeToolRecommendations(
  batches: ToolRecommendation[][],
): ToolRecommendation[] {
  const byName = new Map<string, ToolRecommendation>();
  for (const batch of batches) {
    for (const rec of batch) {
      const existing = byName.get(rec.name);
      if (!existing || rec.confidence > existing.confidence) {
        byName.set(rec.name, rec);
      }
    }
  }
  return [...byName.values()].sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Helper: extract symbol + file recommendations from the index
// ---------------------------------------------------------------------------

function collectSymbolRecommendations(
  parsed: ParsedQuery,
  index: CodeIndex,
): SymbolRecommendation[] {
  if (parsed.symbol_refs.length === 0) return [];
  const byName = new Map<string, SymbolRecommendation>();
  const wantSet = new Set(parsed.symbol_refs);
  for (const sym of index.symbols) {
    if (!wantSet.has(sym.name)) continue;
    const existing = byName.get(sym.name);
    if (existing) continue; // first occurrence wins — stable ordering
    byName.set(sym.name, {
      name: sym.name,
      file: sym.file,
      line: sym.start_line,
      kind: sym.kind,
      score: 1.0,
    });
    if (byName.size >= MAX_SYMBOLS) break;
  }
  return [...byName.values()];
}

function collectFileRecommendations(
  parsed: ParsedQuery,
  index: CodeIndex,
): FileRecommendation[] {
  if (parsed.file_refs.length === 0) return [];
  const out: FileRecommendation[] = [];
  const seen = new Set<string>();
  const fileSet = new Set(index.files.map((f) => f.path));
  for (const ref of parsed.file_refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const inIndex = fileSet.has(ref);
    out.push({
      path: ref,
      score: inIndex ? 1.0 : 0.5,
      reason: inIndex ? "explicit file reference" : "referenced in query",
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper: framework mismatch detection
// ---------------------------------------------------------------------------

function detectFrameworkMismatch(
  normalizedQuery: string,
  frameworkTools: string[],
): boolean {
  if (frameworkTools.length === 0) return false;
  const detectedJoined = frameworkTools.join(" ").toLowerCase();
  for (const [framework, keywords] of Object.entries(KNOWN_FRAMEWORK_KEYWORDS)) {
    for (const kw of keywords) {
      // Word-boundary match inside the normalized query
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(normalizedQuery)) {
        // User mentions this framework. Is it present in detected tool names?
        if (!detectedJoined.includes(framework)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function planTurn(
  repo: string,
  query: string,
  options?: { max_results?: number; skip_session?: boolean },
): Promise<PlanTurnResult> {
  const startedAt = Date.now();
  const maxTools = Math.min(MAX_TOOLS, options?.max_results ?? MAX_TOOLS);
  const skipSession = options?.skip_session === true;

  // --- 1. Guard: index present? -----------------------------------------
  const index = await getCodeIndex(repo);
  if (!index) {
    return buildUnindexedResult(query, startedAt);
  }

  // --- 2. Parse query ---------------------------------------------------
  const parsed = parseQuery(query, index);

  // --- 3. Negative evidence check (STOP_AND_REPORT_GAP) ------------------
  const sessionState = getSessionState();
  const normalizedForCompare = parsed.normalized.replace(/[^\w\s]/g, "").trim();
  let gap: GapAnalysis | undefined;
  if (!skipSession && normalizedForCompare.length > 0) {
    for (const entry of sessionState.negativeEvidence) {
      const entryNormalized = entry.query
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .trim();
      if (entryNormalized === normalizedForCompare) {
        // Negative entries are only recorded when the prior result count was
        // zero, so we short-circuit unconditionally on a match.
        gap = {
          action: "STOP_AND_REPORT_GAP",
          prior_query: entry.query,
          prior_result_count: 0,
          suggestion:
            `Prior call to ${entry.tool} with the same query returned 0 results. ` +
            `Reformulate (broaden pattern / drop file filter / try semantic search) ` +
            `before retrying.`,
        };
        break;
      }
    }
  }

  if (gap) {
    return {
      query,
      truncated: parsed.truncated,
      confidence: 0,
      tools: [],
      symbols: [],
      files: [],
      reveal_required: [],
      already_used: [],
      gap_analysis: gap,
      metadata: {
        intents_detected: parsed.intents.length,
        bm25_candidates: 0,
        embedding_available: false,
        session_queries_seen: sessionState.queries.length,
        duration_ms: Date.now() - startedAt,
        ...(parsed.truncated ? { truncated: true } : {}),
        ...(parsed.is_vague ? { vague_query: true } : {}),
      },
    };
  }

  // --- 4. Build ranker context (parallel fetch) --------------------------
  const toolDefs = getToolDefinitions();

  const [usageFreq, frameworkTools, embeddings] = await Promise.all([
    getUsageFrequency(),
    detectAutoLoadToolsCached(process.cwd()).catch(() => [] as string[]),
    getToolEmbeddings(toolDefs).catch(() => null),
  ]);

  const embeddingAvailable = embeddings !== null && embeddings.size > 0;

  // --- 5. Run ranker per intent, merge results ---------------------------
  const intents = parsed.intents.length > 0 ? parsed.intents : [parsed.normalized];
  const batches: ToolRecommendation[][] = [];
  for (const intent of intents) {
    if (!intent.trim()) continue;
    const ctx: ToolRankerContext = {
      query: intent,
      toolDefs,
      embeddings,
      queryEmbedding: null, // Query embedding computation happens via ranker's external path; optional here
      usageFrequency: usageFreq,
      frameworkTools,
      coreToolNames: CORE_TOOL_NAMES,
    };
    try {
      const recs = rankTools(ctx);
      batches.push(recs);
    } catch {
      // Ranker failure per intent is non-fatal — continue with remaining intents.
      batches.push([]);
    }
  }

  let merged = mergeToolRecommendations(batches);

  // --- 6. Session dedup (already_used) with top-3 retention --------------
  const alreadyCalled = new Set<string>();
  if (!skipSession) {
    for (const q of sessionState.queries) {
      alreadyCalled.add(q.tool);
    }
  }

  const primary: ToolRecommendation[] = [];
  const alreadyUsed: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const rec = merged[i];
    if (!rec) continue;
    const isTop3 = i < 3;
    if (alreadyCalled.has(rec.name) && !isTop3) {
      alreadyUsed.push(rec.name);
    } else {
      primary.push(rec);
    }
  }

  // Cap primary tool list
  let tools = primary.slice(0, maxTools);

  // Fallback when nothing survived
  if (tools.length === 0) {
    tools = [
      {
        name: "discover_tools",
        confidence: 0.3,
        reasoning: "No direct matches, fall back to explicit search",
        is_hidden: !CORE_TOOL_NAMES.has("discover_tools"),
      },
    ];
  }

  // --- 7. reveal_required: hidden tools in primary ----------------------
  const revealRequired: string[] = [];
  for (const rec of tools) {
    if (rec.is_hidden && !CORE_TOOL_NAMES.has(rec.name)) {
      revealRequired.push(rec.name);
    }
  }

  // --- 8. Symbol & file recommendations from index ----------------------
  const symbols = collectSymbolRecommendations(parsed, index).slice(0, MAX_SYMBOLS);
  const files = collectFileRecommendations(parsed, index).slice(0, MAX_FILES);

  // --- 9. Metadata ------------------------------------------------------
  const staleIndex =
    Date.now() - (index.updated_at ?? index.created_at ?? 0) > STALE_INDEX_THRESHOLD_MS;

  const coldStart = usageFreq.size === 0;

  const frameworkMismatch = detectFrameworkMismatch(parsed.normalized, frameworkTools);

  // Low-discrimination: top two tools within 0.05 of each other
  const top1 = tools[0]?.confidence ?? 0;
  const top2 = tools[1]?.confidence ?? 0;
  const lowDiscrimination = tools.length >= 2 && Math.abs(top1 - top2) < 0.05;

  const overallConfidence = tools.length > 0
    ? Math.max(...tools.map((t) => t.confidence))
    : 0;

  // Approximate bm25 candidate count via the batches size (upper bound).
  const bm25Candidates = batches.reduce((sum, b) => sum + b.length, 0);

  const metadata: PlanTurnMetadata = {
    intents_detected: parsed.intents.length,
    bm25_candidates: bm25Candidates,
    embedding_available: embeddingAvailable,
    session_queries_seen: sessionState.queries.length,
    duration_ms: Date.now() - startedAt,
    ...(parsed.truncated ? { truncated: true } : {}),
    ...(parsed.is_vague ? { vague_query: true } : {}),
    ...(staleIndex ? { stale_index: true } : {}),
    ...(lowDiscrimination ? { low_discrimination: true } : {}),
    ...(frameworkMismatch ? { framework_mismatch: true } : {}),
    ...(coldStart ? { cold_start: true } : {}),
  };

  const result: PlanTurnResult = {
    query,
    truncated: parsed.truncated,
    confidence: Math.round(overallConfidence * 1000) / 1000,
    tools,
    symbols,
    files,
    reveal_required: revealRequired,
    already_used: alreadyUsed,
    metadata,
  };

  if (frameworkTools.length > 0) {
    result.framework_context = frameworkTools.slice(0, 5).join(", ");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Output formatter (Task 9)
// ---------------------------------------------------------------------------

/**
 * Format a PlanTurnResult as a human-readable markdown-style string.
 * Edge-case: if no tools, injects a discover_tools fallback.
 */
export function formatPlanTurnResult(result: PlanTurnResult): string {
  // Edge-case: no tools → inject fallback
  const tools = result.tools.length > 0
    ? result.tools.slice(0, 10)
    : [
        {
          name: "discover_tools",
          confidence: 0.3,
          reasoning: "No direct matches, try explicit search",
          is_hidden: false,
        } satisfies ToolRecommendation,
      ];

  // Cap arrays at spec limits
  const symbols = result.symbols.slice(0, 10);
  const files = result.files.slice(0, 5);

  const lines: string[] = [];

  // --- Header ---
  lines.push(`plan_turn: ${result.query}`);
  lines.push(`confidence: ${result.confidence.toFixed(3)} | duration: ${result.metadata.duration_ms}ms`);

  // --- Gap Analysis (early exit) ---
  if (result.gap_analysis) {
    lines.push(`\n⛔ STOP_AND_REPORT_GAP`);
    lines.push(`prior_query: ${result.gap_analysis.prior_query}`);
    lines.push(`prior_result_count: ${result.gap_analysis.prior_result_count}`);
    lines.push(`suggestion: ${result.gap_analysis.suggestion}`);
    return lines.join("\n");
  }

  // --- Tools section (primary) ---
  lines.push(`\n─── Tools (${tools.length}) ───`);
  for (const t of tools) {
    const conf = t.confidence.toFixed(3);
    const hidden = t.is_hidden ? " [hidden]" : "";
    lines.push(`  ${t.name}${hidden}  confidence: ${conf}`);
    lines.push(`    ${t.reasoning}`);
  }

  // --- Already Used ---
  if (result.already_used.length > 0) {
    lines.push(`\n─── Already Used (${result.already_used.length}) ───`);
    lines.push(`  ${result.already_used.join(", ")}`);
  }

  // --- Reveal Required ---
  if (result.reveal_required.length > 0) {
    lines.push(`\n─── Reveal Required (${result.reveal_required.length}) ───`);
    lines.push(`  These tools are hidden — call describe_tools(names=[...]) to reveal:`);
    lines.push(`  ${result.reveal_required.join(", ")}`);
  }

  // --- Symbols ---
  if (symbols.length > 0) {
    lines.push(`\n─── Symbols (${symbols.length}) ───`);
    for (const s of symbols) {
      lines.push(`  ${s.kind} ${s.name}  ${s.file}:${s.line}`);
    }
  }

  // --- Files ---
  if (files.length > 0) {
    lines.push(`\n─── Files (${files.length}) ───`);
    for (const f of files) {
      lines.push(`  ${f.path}  score: ${f.score.toFixed(2)}  (${f.reason})`);
    }
  }

  // --- Metadata footer (key flags only) ---
  const flags: string[] = [];
  if (result.metadata.vague_query) flags.push("vague_query");
  if (result.metadata.stale_index) flags.push("stale_index");
  if (result.metadata.framework_mismatch) flags.push("framework_mismatch");
  if (result.metadata.cold_start) flags.push("cold_start");
  if (flags.length > 0) {
    lines.push(`\n─── Flags ───`);
    lines.push(`  ${flags.join(", ")}`);
  }

  return lines.join("\n");
}
