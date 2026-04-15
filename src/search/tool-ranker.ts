/**
 * Tool-ranker — ranks MCP tool definitions against a natural-language query
 * using BM25 (lexical), exact-name (identity), embedding cosine (semantic),
 * usage frequency (structural), and framework-match (framework) signals.
 *
 * Used by the `plan_turn` / tool-recommendation meta tools to surface the
 * most relevant tools for an agent's current intent.
 *
 * All signals are optional — semantic and structural gracefully degrade to
 * zero when the corresponding input is unavailable (e.g. no embedding API
 * key, fresh session with no usage history).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildBM25Index, searchBM25, tokenizeText, type BM25Index } from "./bm25.js";
import { batchEmbed } from "../storage/embedding-store.js";
import { createEmbeddingProvider } from "./semantic.js";
import { loadConfig } from "../config.js";
import { atomicWriteFile } from "../storage/_shared.js";
import type { CodeSymbol } from "../types.js";
import type { ToolDefinition } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolRecommendation {
  name: string;
  confidence: number;
  reasoning: string;
  suggested_params?: Record<string, string>;
  is_hidden: boolean;
}

export interface ToolRankerContext {
  query: string;
  toolDefs: readonly ToolDefinition[];
  embeddings: Map<string, number[]> | null;
  queryEmbedding: number[] | null;
  usageFrequency: Map<string, number>;
  frameworkTools: string[];
  /**
   * Names of tools visible in ListTools (core tools). When provided, tools
   * outside this set are flagged as `is_hidden=true` in the recommendation.
   * Defaults to an empty set → every tool is reported as hidden.
   */
  coreToolNames?: Set<string>;
}

/** Per-signal contributions for a single tool — used for reasoning + debugging. */
interface SignalBreakdown {
  lexical: number;      // 0..1 (BM25 normalized)
  identity: number;     // 0 or 1
  semantic: number;     // 0..1 (cosine similarity)
  structural: number;   // 0..1 (usage normalized)
  framework: number;    // 0 or 1
  lexicalTokens: string[];
}

// ---------------------------------------------------------------------------
// Signal weights
// ---------------------------------------------------------------------------

const W_LEXICAL = 1.0;
const W_IDENTITY = 2.0;
const W_SEMANTIC = 0.8;
const W_STRUCTURAL = 0.1;
const W_FRAMEWORK = 0.6;

const BM25_TOP_K = 50;
const MAX_RECOMMENDATIONS = 10;

// Field weights for the synthetic tool BM25 index. We keep this separate from
// the global code-symbol weights because for tools, `signature` holds the
// description and `docstring` holds the searchHint — name is still king.
const TOOL_FIELD_WEIGHTS = {
  name: 5.0,
  signature: 2.5,
  docstring: 2.0,
  body: 0.0,
  comments: 0.0,
};

// ---------------------------------------------------------------------------
// Task 1 — BM25 adapter + module cache
// ---------------------------------------------------------------------------

interface ToolBM25Cache {
  fingerprint: string;
  index: BM25Index;
}

let bm25Cache: ToolBM25Cache | null = null;

/**
 * Compute a stable fingerprint for a list of tool definitions. Used to
 * invalidate the BM25 cache when the tool catalog is modified (tests,
 * hot-reload, new deployments).
 *
 * Exported for tests that need to predict cache-hit behaviour.
 */
export function toolDefsFingerprint(toolDefs: readonly ToolDefinition[]): string {
  // Stable subset: name, description, searchHint, category. Schema handler
  // is not stringifiable and not relevant to ranking.
  const subset = toolDefs.map((d) => [
    d.name,
    d.description,
    d.searchHint ?? "",
    d.category ?? "",
  ]);
  return createHash("sha1")
    .update(JSON.stringify(subset))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Map a `ToolDefinition` to a synthetic `CodeSymbol` so we can reuse the
 * existing BM25 index and scoring pipeline.
 *
 * - id / name          → tool name
 * - signature          → description (BM25 will tokenise it)
 * - docstring          → searchHint keywords
 * - file               → "__tools__/{category}.tool"
 */
function toolToSymbol(def: ToolDefinition): CodeSymbol {
  const category = def.category ?? "uncategorized";
  return {
    id: def.name,
    repo: "__tools__",
    name: def.name,
    kind: "function",
    file: `__tools__/${category}.tool`,
    start_line: 1,
    end_line: 1,
    signature: def.description,
    docstring: def.searchHint ?? "",
  };
}

/**
 * Build (or return cached) BM25 index for a tool catalog. Cache is keyed
 * by fingerprint — subsequent calls with the same shape return instantly.
 */
export function buildToolBM25Index(toolDefs: readonly ToolDefinition[]): BM25Index {
  const fingerprint = toolDefsFingerprint(toolDefs);
  if (bm25Cache && bm25Cache.fingerprint === fingerprint) {
    return bm25Cache.index;
  }

  const symbols = toolDefs.map(toolToSymbol);
  const index = buildBM25Index(symbols);
  bm25Cache = { fingerprint, index };
  return index;
}

/** Clear the BM25 cache — for tests and hot-reload. */
export function clearToolBM25Cache(): void {
  bm25Cache = null;
}

// ---------------------------------------------------------------------------
// Helpers — signal computation
// ---------------------------------------------------------------------------

/**
 * Compute BM25 lexical score and matched tokens for each tool.
 * Returns a map from tool name → { score (normalised 0..1), matches }.
 */
function computeLexical(
  query: string,
  index: BM25Index,
): Map<string, { score: number; matches: string[] }> {
  const results = searchBM25(index, query, BM25_TOP_K, TOOL_FIELD_WEIGHTS);
  const out = new Map<string, { score: number; matches: string[] }>();
  if (results.length === 0) return out;

  const top = results[0]?.score ?? 0;
  if (top <= 0) return out;

  for (const r of results) {
    const normalised = r.score / top;
    out.set(r.symbol.id, {
      score: normalised,
      matches: r.matches ?? [],
    });
  }
  return out;
}

/**
 * Identity signal — tool name appears verbatim in the query (case-insensitive).
 * Returns 1.0 for an exact substring match, else 0.
 */
function computeIdentity(query: string, toolName: string): number {
  const q = query.toLowerCase();
  const n = toolName.toLowerCase();
  if (!n) return 0;

  // Whole-name appearance
  if (q.includes(n)) return 1;

  // snake_case → space-separated variant (e.g. "find dead code" vs "find_dead_code")
  const spaced = n.replace(/_/g, " ");
  if (q.includes(spaced)) return 1;

  return 0;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when lengths differ (defensive — caller guarantees equality).
 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let nA = 0;
  let nB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    nA += ai * ai;
    nB += bi * bi;
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Structural signal — normalised usage frequency.
 * Returns value / max(values), clamped to [0..1].
 */
function normaliseUsage(usage: Map<string, number>, toolName: string): number {
  if (usage.size === 0) return 0;
  const value = usage.get(toolName) ?? 0;
  if (value <= 0) return 0;
  let max = 0;
  for (const v of usage.values()) if (v > max) max = v;
  return max > 0 ? Math.min(1, value / max) : 0;
}

// ---------------------------------------------------------------------------
// Task 4 — Reasoning template
// ---------------------------------------------------------------------------

/**
 * Render a one-line, human-readable reason explaining why this tool was
 * picked. Falls back to a generic "general match" when no signal dominates.
 */
export function generateReasoning(
  id: string,
  query: string,
  signals: SignalBreakdown,
): string {
  const reasons: string[] = [];

  if (signals.identity > 0) {
    reasons.push("exact name match");
  }

  if (signals.lexical > 0.01 && signals.lexicalTokens.length > 0) {
    const top = signals.lexicalTokens.slice(0, 3).join(", ");
    reasons.push(`keywords: ${top}`);
  }

  if (signals.semantic >= 0.55) {
    reasons.push("semantic similarity");
  }

  if (signals.structural >= 0.5) {
    reasons.push("high usage frequency");
  }

  if (signals.framework > 0) {
    reasons.push("relevant to project stack");
  }

  if (reasons.length === 0) {
    // Fall back — still mention what was attempted.
    const stem = query.trim().slice(0, 30) || id;
    return `general match for "${stem}"`;
  }

  return reasons.join("; ");
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

const VAGUE_WORDS = new Set([
  "help", "code", "find", "search", "what", "how", "show", "look",
]);

/**
 * Apply calibration rules that cap confidence for vague or ambiguous queries.
 * Returns the (possibly reduced) confidence for the top recommendation and
 * by extension all downstream confidences (scaled proportionally).
 */
function calibrationCap(
  query: string,
  tokens: string[],
  topScore: number,
  secondScore: number,
): number {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // Rule 1 — vague query (all tokens in VAGUE_WORDS, or very short)
  const allVague =
    tokens.length > 0 && tokens.every((t) => VAGUE_WORDS.has(t));
  if (trimmed.length < 10 || allVague) {
    return 0.5;
  }

  // Rule 2 — single-keyword query
  if (wordCount === 1 || tokens.length <= 1) {
    return 0.6;
  }

  // Rule 3 — low discrimination: top and runner-up are indistinguishable
  if (topScore > 0 && topScore - secondScore < 0.1) {
    return 0.4;
  }

  return 1.0; // no cap
}

// ---------------------------------------------------------------------------
// Task 2 + 3 — rankTools
// ---------------------------------------------------------------------------

/**
 * Rank tools against a natural-language query by combining lexical, identity,
 * semantic, structural, and framework signals. Returns up to 10 `ToolRecommendation`
 * entries sorted by raw weighted score, with calibrated confidence values.
 *
 * Gracefully handles missing inputs:
 *   - no embeddings           → semantic contribution is 0
 *   - empty usageFrequency    → structural contribution is 0
 *   - empty frameworkTools    → framework contribution is 0
 */
export function rankTools(ctx: ToolRankerContext): ToolRecommendation[] {
  const { query, toolDefs, embeddings, queryEmbedding, usageFrequency, frameworkTools } = ctx;
  const coreToolNames = ctx.coreToolNames ?? new Set<string>();
  if (toolDefs.length === 0 || !query.trim()) return [];

  const queryTokens = tokenizeText(query);
  const frameworkSet = new Set(frameworkTools);

  // --- Lexical (BM25) -------------------------------------------------
  const index = buildToolBM25Index(toolDefs);
  const lexical = computeLexical(query, index);

  // --- Semantic (iterate ALL tools, not just BM25 candidates) --------
  const semantic = new Map<string, number>();
  if (embeddings && queryEmbedding && queryEmbedding.length > 0) {
    for (const def of toolDefs) {
      const vec = embeddings.get(def.name);
      if (!vec || vec.length === 0) continue;
      const sim = cosine(queryEmbedding, vec);
      if (sim > 0) semantic.set(def.name, sim);
    }
  }

  // --- Per-tool scoring ----------------------------------------------
  interface Scored {
    def: ToolDefinition;
    raw: number;
    signals: SignalBreakdown;
  }

  const scored: Scored[] = [];
  for (const def of toolDefs) {
    const lex = lexical.get(def.name);
    const lexScore = lex?.score ?? 0;
    const lexTokens = lex?.matches ?? [];

    const idScore = computeIdentity(query, def.name);
    const semScore = semantic.get(def.name) ?? 0;
    const strScore = normaliseUsage(usageFrequency, def.name);
    const frameworkScore = frameworkSet.has(def.name) ? 1 : 0;

    const raw =
      W_LEXICAL * lexScore +
      W_IDENTITY * idScore +
      W_SEMANTIC * semScore +
      W_STRUCTURAL * strScore +
      W_FRAMEWORK * frameworkScore;

    if (raw <= 0) continue;

    scored.push({
      def,
      raw,
      signals: {
        lexical: lexScore,
        identity: idScore,
        semantic: semScore,
        structural: strScore,
        framework: frameworkScore,
        lexicalTokens: lexTokens,
      },
    });
  }

  scored.sort((a, b) => b.raw - a.raw);
  const top = scored.slice(0, MAX_RECOMMENDATIONS);
  if (top.length === 0) return [];

  // --- Confidence normalisation + calibration ------------------------
  const topRaw = top[0]?.raw ?? 0;
  const secondRaw = top[1]?.raw ?? 0;
  const cap = calibrationCap(query, queryTokens, topRaw, secondRaw);

  const recommendations: ToolRecommendation[] = top.map((s) => {
    // Normalise raw → 0..1 via division by topRaw, then apply cap.
    const normalised = topRaw > 0 ? s.raw / topRaw : 0;
    const confidence = Math.max(0, Math.min(cap, normalised * cap));

    const reasoning = generateReasoning(s.def.name, query, s.signals);
    const isHidden = !coreToolNames.has(s.def.name);

    const rec: ToolRecommendation = {
      name: s.def.name,
      confidence: Math.round(confidence * 1000) / 1000,
      reasoning,
      is_hidden: isHidden,
    };
    return rec;
  });

  return recommendations;
}

// ---------------------------------------------------------------------------
// Task 5 — Tool-embedding cache
// ---------------------------------------------------------------------------

const TOOL_EMBEDDING_CACHE_KEY = "__tool_descriptions__";

interface CachedToolEmbeddings {
  fingerprint: string;
  embeddings: Record<string, number[]>;
}

/** Absolute path to the on-disk tool-embedding cache. */
export function getToolEmbeddingCachePath(): string {
  return join(homedir(), ".codesift", "tool-embeddings.ndjson");
}

async function readToolEmbeddingCache(
  path: string,
): Promise<CachedToolEmbeddings | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["fingerprint"] === "string" &&
      typeof (parsed as Record<string, unknown>)["embeddings"] === "object"
    ) {
      return parsed as CachedToolEmbeddings;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeToolEmbeddingCache(
  path: string,
  cache: CachedToolEmbeddings,
): Promise<void> {
  try {
    await atomicWriteFile(path, JSON.stringify(cache));
  } catch {
    // Cache write failures are non-fatal — ranker still works, just slower next call.
  }
}

/**
 * Fetch (or compute) embeddings for every tool in `defs`. Uses the on-disk
 * cache when the fingerprint matches; otherwise regenerates via the configured
 * embedding provider and persists the result.
 *
 * Returns:
 *   - `Map<toolName, number[]>` on success
 *   - `null` when no embedding provider is configured (no API key) or the
 *     provider call fails — callers should degrade to non-semantic ranking.
 */
export async function getToolEmbeddings(
  defs: readonly ToolDefinition[],
): Promise<Map<string, number[]> | null> {
  if (defs.length === 0) return new Map();

  const config = loadConfig();
  if (!config.embeddingProvider) return null;

  const fingerprint = toolDefsFingerprint(defs);
  const cachePath = getToolEmbeddingCachePath();

  const cached = await readToolEmbeddingCache(cachePath);
  if (cached && cached.fingerprint === fingerprint) {
    const m = new Map<string, number[]>();
    for (const [k, v] of Object.entries(cached.embeddings)) {
      if (Array.isArray(v)) m.set(k, v);
    }
    return m;
  }

  // Regenerate via provider
  try {
    const provider = createEmbeddingProvider(config.embeddingProvider, config);
    const texts = new Map<string, string>();
    for (const d of defs) {
      const text = [d.name, d.description, d.searchHint ?? ""]
        .filter(Boolean)
        .join("\n");
      texts.set(d.name, text);
    }

    const existing = new Map<string, Float32Array>();
    const result = await batchEmbed(
      texts,
      existing,
      provider.embed.bind(provider),
      config.embeddingBatchSize,
      TOOL_EMBEDDING_CACHE_KEY,
    );

    const out = new Map<string, number[]>();
    const recordForDisk: Record<string, number[]> = {};
    for (const [name, vec] of result) {
      const asArray = Array.from(vec);
      out.set(name, asArray);
      recordForDisk[name] = asArray;
    }

    await writeToolEmbeddingCache(cachePath, {
      fingerprint,
      embeddings: recordForDisk,
    });

    return out;
  } catch {
    return null;
  }
}
