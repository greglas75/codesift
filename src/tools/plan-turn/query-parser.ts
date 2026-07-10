import type { CodeIndex } from "../../types.js";
import type { ParsedQuery } from "./types.js";

const MAX_QUERY_LENGTH = 1000;

const VAGUE_STOPWORDS = new Set([
  "help", "hi", "hello", "what", "how", "why", "please", "can", "could",
]);

const DOMAIN_KEYWORDS = new Set([
  "find", "search", "audit", "analyze", "trace", "review", "check",
  "show", "get", "list", "detect", "scan",
]);

const FILE_EXT_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/g;
const IDENT_RE = /\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g;
const MULTI_INTENT_RE = /\s+(?:and|or|;|&&)\s+/i;

export function parseQuery(raw: string, index: CodeIndex): ParsedQuery {
  const original = raw;
  const truncated = raw.length > MAX_QUERY_LENGTH;
  const normalized = raw.slice(0, MAX_QUERY_LENGTH).toLowerCase().trim();

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

  const intents = normalized.split(MULTI_INTENT_RE);
  const file_refs = Array.from(new Set(normalized.match(FILE_EXT_RE) ?? []));
  const symbolNames = new Set(index.symbols.map((symbol) => symbol.name));
  const candidateTokens = Array.from(
    new Set(raw.slice(0, MAX_QUERY_LENGTH).match(IDENT_RE) ?? []),
  );
  const symbol_refs = candidateTokens.filter((token) => symbolNames.has(token));
  const words = normalized.split(/\s+/).filter(Boolean);
  const containsDomainKeyword = words.some((word) => DOMAIN_KEYWORDS.has(word));
  const allStopwords = words.every((word) => VAGUE_STOPWORDS.has(word));
  const is_vague = normalized.length < 15
    && words.length < 3
    && (!containsDomainKeyword || allStopwords);

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
