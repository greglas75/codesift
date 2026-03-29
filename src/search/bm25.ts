import { tokenizeIdentifier } from "../parser/symbol-extractor.js";
import { isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, SearchResult } from "../types.js";

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

const BODY_CHAR_LIMIT = 500;

/**
 * Score multiplier for symbols in test files.
 * Demotes test helpers so production code ranks higher in search results.
 * 0.3 = test symbols score 30% of equivalent production symbols.
 */
const TEST_FILE_SCORE_MULTIPLIER = 0.3;

type FieldName = "name" | "signature" | "docstring" | "body" | "comments";

export interface BM25Index {
  /** Per-field inverted index: token -> Map<symbolId, termFrequency> */
  fields: Record<FieldName, Map<string, Map<string, number>>>;
  /** Per-field average document length (in tokens) */
  avgFieldLengths: Record<FieldName, number>;
  /** Total number of indexed documents */
  docCount: number;
  /** Symbol lookup by ID */
  symbols: Map<string, CodeSymbol>;
  /** Import centrality: file -> log-scaled importer count (for search ranking bonus) */
  centrality: Map<string, number>;
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
  const source = symbol.source?.slice(0, BODY_CHAR_LIMIT) ?? "";
  const { code, comments } = splitCodeAndComments(source);

  return {
    name: tokenizeIdentifier(symbol.name),
    signature: symbol.signature ? tokenizeText(symbol.signature) : [],
    docstring: symbol.docstring ? tokenizeText(symbol.docstring) : [],
    body: source ? tokenizeText(code) : [],
    comments: comments ? tokenizeText(comments) : [],
  };
}

/**
 * Split source into code (logic) vs inline comments.
 * Strips single-line (//) and multi-line comments from code,
 * collects them into a separate string.
 *
 * Limitation: regex-based, so `//` inside string literals (e.g. URLs)
 * may be misclassified as comments. Acceptable for BM25 scoring where
 * a few misclassified tokens have negligible impact on ranking.
 */
function splitCodeAndComments(source: string): { code: string; comments: string } {
  const commentParts: string[] = [];
  // Match // comments and /* ... */ blocks
  const stripped = source.replace(/\/\/[^\n]*/g, (m) => {
    commentParts.push(m);
    return "";
  }).replace(/\/\*[\s\S]*?\*\//g, (m) => {
    commentParts.push(m);
    return "";
  });

  return { code: stripped, comments: commentParts.join(" ") };
}

function countTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

export function buildBM25Index(symbols: CodeSymbol[]): BM25Index {
  const fieldNames: FieldName[] = ["name", "signature", "docstring", "body", "comments"];

  const fields: Record<FieldName, Map<string, Map<string, number>>> = {
    name: new Map(),
    signature: new Map(),
    docstring: new Map(),
    body: new Map(),
    comments: new Map(),
  };

  const totalFieldLengths: Record<FieldName, number> = {
    name: 0,
    signature: 0,
    docstring: 0,
    body: 0,
    comments: 0,
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
    comments: docCount > 0 ? totalFieldLengths.comments / docCount : 0,
  };

  // Compute import centrality: count how many files import each file
  // Heuristic: scan symbol source for import/require patterns pointing to files in the index
  const importCount = new Map<string, number>();
  const allFiles = new Set<string>();
  for (const sym of symbols) allFiles.add(sym.file);

  for (const sym of symbols) {
    if (!sym.source) continue;
    // Quick regex for import paths (captures relative paths)
    const importRe = /from\s+['"]\.?\.\/([\w/.-]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(sym.source)) !== null) {
      const imported = match[1]!;
      // Try to match against known files
      for (const file of allFiles) {
        if (file.includes(imported)) {
          importCount.set(file, (importCount.get(file) ?? 0) + 1);
          break;
        }
      }
    }
  }

  // Log-scale centrality: avoids a single highly-imported utility from dominating
  const centrality = new Map<string, number>();
  for (const [file, count] of importCount) {
    centrality.set(file, Math.log2(1 + count));
  }

  return { fields, avgFieldLengths, docCount, symbols: symbolMap, centrality };
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

  const fieldNames: FieldName[] = ["name", "signature", "docstring", "body", "comments"];

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
      comments: 0,
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

  // Centrality bonus: symbols in frequently-imported files get a tiebreaker
  const maxCentrality = Math.max(1, ...index.centrality.values());
  for (const [symbolId, score] of scores) {
    const symbol = index.symbols.get(symbolId);
    if (!symbol) continue;

    let adjusted = score;

    // Centrality: 0-10% bonus scaled by file import popularity
    const fileCentrality = index.centrality.get(symbol.file) ?? 0;
    if (fileCentrality > 0) {
      adjusted += score * 0.1 * (fileCentrality / maxCentrality);
    }

    // Demote test file symbols so production code ranks above test helpers
    if (isTestFile(symbol.file)) {
      adjusted *= TEST_FILE_SCORE_MULTIPLIER;
    }

    scores.set(symbolId, adjusted);
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

const CUTOFF_THRESHOLD = 0.15;
const CUTOFF_MIN_RESULTS = 3;

export function applyCutoff(results: SearchResult[]): SearchResult[] {
  if (results.length <= CUTOFF_MIN_RESULTS) return results;
  const topScore = results[0]?.score ?? 0;
  if (topScore <= 0) return results;
  const threshold = topScore * CUTOFF_THRESHOLD;
  for (let i = CUTOFF_MIN_RESULTS; i < results.length; i++) {
    if ((results[i]?.score ?? 0) < threshold) {
      return results.slice(0, i);
    }
  }
  return results;
}
