/**
 * plan-turn-tools.ts — Query parser for plan/turn routing.
 *
 * Parses a raw agent query into structured intent signals:
 *   - Normalisation (lowercase, trim, 1000-char cap)
 *   - Multi-intent split on "and / or / ; / &&" with surrounding whitespace
 *   - File ref extraction (extensions: ts/tsx/js/jsx/py/go/rs/php/kt/sql)
 *   - Symbol ref extraction (cross-referenced against index.symbols)
 *   - Vague detection (short query with no domain keywords)
 *
 * Handler (Task 7) will be added to this same file.
 */

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
