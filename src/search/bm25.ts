import { tokenizeIdentifier } from "../parser/symbol-extractor.js";
import type { CodeSymbol, SearchResult } from "../types.js";

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

const BODY_CHAR_LIMIT = 500;

type FieldName = "name" | "signature" | "docstring" | "body";

export interface BM25Index {
  /** Per-field inverted index: token -> Map<symbolId, termFrequency> */
  fields: Record<FieldName, Map<string, Map<string, number>>>;
  /** Per-field average document length (in tokens) */
  avgFieldLengths: Record<FieldName, number>;
  /** Total number of indexed documents */
  docCount: number;
  /** Symbol lookup by ID */
  symbols: Map<string, CodeSymbol>;
}

/**
 * General-purpose tokenizer for signature, docstring, and body text.
 * Splits on non-alphanumeric chars, applies camelCase/snake_case splitting,
 * lowercases, and filters tokens shorter than 2 chars.
 */
export function tokenizeText(text: string): string[] {
  // Split on non-alphanumeric boundaries
  const rawParts = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  const tokens: string[] = [];
  for (const part of rawParts) {
    // Split camelCase / PascalCase (same logic as tokenizeIdentifier)
    const subParts = part
      .replace(/([a-z0-9])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0");

    for (const sub of subParts) {
      const lower = sub.toLowerCase();
      if (lower.length >= 2) {
        tokens.push(lower);
      }
    }
  }

  return tokens;
}

function getFieldTokens(symbol: CodeSymbol): Record<FieldName, string[]> {
  return {
    name: tokenizeIdentifier(symbol.name),
    signature: symbol.signature ? tokenizeText(symbol.signature) : [],
    docstring: symbol.docstring ? tokenizeText(symbol.docstring) : [],
    body: symbol.source
      ? tokenizeText(symbol.source.slice(0, BODY_CHAR_LIMIT))
      : [],
  };
}

function countTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

export function buildBM25Index(symbols: CodeSymbol[]): BM25Index {
  const fieldNames: FieldName[] = ["name", "signature", "docstring", "body"];

  const fields: Record<FieldName, Map<string, Map<string, number>>> = {
    name: new Map(),
    signature: new Map(),
    docstring: new Map(),
    body: new Map(),
  };

  const totalFieldLengths: Record<FieldName, number> = {
    name: 0,
    signature: 0,
    docstring: 0,
    body: 0,
  };

  const symbolMap = new Map<string, CodeSymbol>();

  for (const symbol of symbols) {
    symbolMap.set(symbol.id, symbol);
    const fieldTokens = getFieldTokens(symbol);

    for (const field of fieldNames) {
      const tokens = fieldTokens[field];
      totalFieldLengths[field] += tokens.length;

      const tf = countTermFrequencies(tokens);
      for (const [token, freq] of tf) {
        let postings = fields[field].get(token);
        if (!postings) {
          postings = new Map();
          fields[field].set(token, postings);
        }
        postings.set(symbol.id, freq);
      }
    }
  }

  const docCount = symbols.length;
  const avgFieldLengths: Record<FieldName, number> = {
    name: docCount > 0 ? totalFieldLengths.name / docCount : 0,
    signature: docCount > 0 ? totalFieldLengths.signature / docCount : 0,
    docstring: docCount > 0 ? totalFieldLengths.docstring / docCount : 0,
    body: docCount > 0 ? totalFieldLengths.body / docCount : 0,
  };

  return { fields, avgFieldLengths, docCount, symbols: symbolMap };
}

export function searchBM25(
  index: BM25Index,
  query: string,
  topK: number,
  fieldWeights: Record<FieldName, number>,
): SearchResult[] {
  if (index.docCount === 0 || !query.trim()) {
    return [];
  }

  const queryTokens = tokenizeText(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const fieldNames: FieldName[] = ["name", "signature", "docstring", "body"];

  // Accumulate scores per document
  const scores = new Map<string, number>();
  // Track which query tokens matched per document
  const matchedTokens = new Map<string, Set<string>>();

  // Pre-compute field lengths per document per field
  // We derive field length from the sum of term frequencies in each field's postings
  const fieldLengths = new Map<string, Record<FieldName, number>>();

  for (const [symbolId] of index.symbols) {
    const lengths: Record<FieldName, number> = {
      name: 0,
      signature: 0,
      docstring: 0,
      body: 0,
    };
    fieldLengths.set(symbolId, lengths);
  }

  // Compute field lengths by summing all term frequencies per doc per field
  for (const field of fieldNames) {
    for (const [, postings] of index.fields[field]) {
      for (const [symbolId, freq] of postings) {
        const lengths = fieldLengths.get(symbolId);
        if (lengths) {
          lengths[field] += freq;
        }
      }
    }
  }

  for (const qToken of queryTokens) {
    for (const field of fieldNames) {
      const postings = index.fields[field].get(qToken);
      if (!postings) continue;

      const df = postings.size;
      const idf = Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);
      const avgFl = index.avgFieldLengths[field];
      const weight = fieldWeights[field];

      for (const [symbolId, tf] of postings) {
        const fl = fieldLengths.get(symbolId)?.[field] ?? 0;
        const norm = avgFl > 0 ? fl / avgFl : 1;
        const tfScore = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm));
        const fieldScore = idf * tfScore * weight;

        scores.set(symbolId, (scores.get(symbolId) ?? 0) + fieldScore);

        let tokenSet = matchedTokens.get(symbolId);
        if (!tokenSet) {
          tokenSet = new Set();
          matchedTokens.set(symbolId, tokenSet);
        }
        tokenSet.add(qToken);
      }
    }
  }

  // Sort by score descending, take top-K
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  const results: SearchResult[] = [];
  for (const [symbolId, score] of sorted) {
    const symbol = index.symbols.get(symbolId);
    if (!symbol) continue;

    results.push({
      symbol,
      score,
      matches: [...(matchedTokens.get(symbolId) ?? [])],
    });
  }

  return results;
}
