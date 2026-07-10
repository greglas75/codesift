import type { CodeIndex } from "../../types.js";
import type { ParsedQuery } from "./types.js";

export const MAX_QUERY_LENGTH = 1000;

export function capQuery(raw: string): string {
  return raw.slice(0, MAX_QUERY_LENGTH);
}

const VAGUE_STOPWORDS = new Set([
  "help", "hi", "hello", "what", "how", "why", "please", "can", "could",
]);

const DOMAIN_KEYWORDS = new Set([
  "find", "search", "audit", "analyze", "trace", "review", "check",
  "show", "get", "list", "detect", "scan",
]);

const FILE_EXT_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|php|kt|sql)\b/gi;
const IDENT_RE = /\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g;
const MULTI_INTENT_RE = /\s+(?:and|or)\s+|\s*(?:;|&&)\s*/i;

export function parseQuery(raw: string, index: CodeIndex): ParsedQuery {
  const original = capQuery(raw);
  const truncated = raw.length > MAX_QUERY_LENGTH;
  const normalized = original.toLowerCase().trim();

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

  const intents = normalized.split(MULTI_INTENT_RE).filter(Boolean);
  const file_refs = Array.from(new Set(original.match(FILE_EXT_RE) ?? []));
  const candidateTokens = Array.from(
    new Set(original.match(IDENT_RE) ?? []),
  );
  const wantedTokens = new Set(candidateTokens);
  const matchedTokens = new Set<string>();
  if (wantedTokens.size > 0) {
    for (const symbol of index.symbols) {
      if (wantedTokens.has(symbol.name)) matchedTokens.add(symbol.name);
      if (matchedTokens.size === wantedTokens.size) break;
    }
  }
  const symbol_refs = candidateTokens.filter((token) => matchedTokens.has(token));
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
