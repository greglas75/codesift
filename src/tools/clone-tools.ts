import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

const MIN_CLONE_LINES = 10;
const MAX_CLONES = 50;
const DEFAULT_MIN_SIMILARITY = 0.7;
/** Max line-count ratio for near-match comparison (30% tolerance) */
const MAX_LINE_RATIO = 1.3;

export interface CodeClone {
  symbol_a: { name: string; kind: SymbolKind; file: string; start_line: number; end_line: number };
  symbol_b: { name: string; kind: SymbolKind; file: string; start_line: number; end_line: number };
  similarity: number;        // 0-1, where 1 = exact match
  shared_lines: number;      // approximate overlapping line count
}

export interface CloneResult {
  clones: CodeClone[];
  scanned_symbols: number;
  threshold: number;
}

interface CloneEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  lines: string[];
  hash: number;
}

const ANALYZABLE_KINDS = new Set<SymbolKind>([
  "function", "method", "class", "component", "hook",
]);

/**
 * Normalize source for comparison: strip whitespace, comments, string literals.
 * Returns array of normalized non-empty lines.
 */
function normalizeSource(source: string): string[] {
  return source
    .split("\n")
    .map((line) => {
      let l = line.trim();
      // Strip single-line comments
      const commentIdx = l.indexOf("//");
      if (commentIdx >= 0) l = l.slice(0, commentIdx).trim();
      // Normalize whitespace
      l = l.replace(/\s+/g, " ");
      return l;
    })
    .filter((l) => l.length > 0 && l !== "{" && l !== "}" && l !== ");");
}

/**
 * Simple fingerprint: hash of normalized lines joined.
 * Uses djb2 for speed (not crypto).
 */
function hashLines(lines: string[]): number {
  let hash = 5381;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
    }
  }
  return hash;
}

/**
 * Compute line-level similarity between two normalized sources.
 * Uses set intersection of lines (bag-of-lines similarity).
 */
function computeSimilarity(linesA: string[], linesB: string[]): { similarity: number; sharedLines: number } {
  const setA = new Set(linesA);
  const setB = new Set(linesB);
  let shared = 0;
  for (const line of setA) {
    if (setB.has(line)) shared++;
  }
  const total = Math.max(setA.size, setB.size);
  return {
    similarity: total > 0 ? Math.round((shared / total) * 100) / 100 : 0,
    sharedLines: shared,
  };
}

/** Build a CodeClone from two entries and their similarity result */
function buildClone(
  a: CloneEntry,
  b: CloneEntry,
  similarity: number,
  sharedLines: number,
): CodeClone {
  return {
    symbol_a: { name: a.name, kind: a.kind, file: a.file, start_line: a.start_line, end_line: a.end_line },
    symbol_b: { name: b.name, kind: b.kind, file: b.file, start_line: b.start_line, end_line: b.end_line },
    similarity,
    shared_lines: sharedLines,
  };
}

/** Filter, normalize, and hash symbols into clone-comparable entries */
function prepareEntries(
  symbols: Array<{ name: string; kind: SymbolKind; file: string; start_line: number; end_line: number; source?: string }>,
  minLines: number,
  includeTests: boolean,
  filePattern: string | undefined,
): CloneEntry[] {
  const entries: CloneEntry[] = [];

  for (const sym of symbols) {
    if (!ANALYZABLE_KINDS.has(sym.kind)) continue;
    if (!sym.source) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    const lines = normalizeSource(sym.source);
    if (lines.length < minLines) continue;

    entries.push({
      name: sym.name,
      kind: sym.kind,
      file: sym.file,
      start_line: sym.start_line,
      end_line: sym.end_line,
      lines,
      hash: hashLines(lines),
    });
  }

  return entries;
}

/** Phase 1: Find exact hash matches via O(n) bucketing */
function findExactMatches(
  entries: CloneEntry[],
  minSimilarity: number,
  minLines: number,
  maxClones: number,
): CodeClone[] {
  const clones: CodeClone[] = [];
  const hashBuckets = new Map<number, CloneEntry[]>();

  for (const entry of entries) {
    const bucket = hashBuckets.get(entry.hash);
    if (bucket) bucket.push(entry);
    else hashBuckets.set(entry.hash, [entry]);
  }

  for (const bucket of hashBuckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (clones.length >= maxClones) break;
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (a.file === b.file && a.start_line === b.start_line) continue;
        const { similarity, sharedLines } = computeSimilarity(a.lines, b.lines);
        if (similarity >= minSimilarity && sharedLines >= minLines) {
          clones.push(buildClone(a, b, similarity, sharedLines));
        }
      }
    }
  }

  return clones;
}

/** Phase 2: Find near-matches by comparing entries with similar line counts */
function findNearMatches(
  entries: CloneEntry[],
  existingClones: CodeClone[],
  minSimilarity: number,
  minLines: number,
  maxClones: number,
): CodeClone[] {
  const clones: CodeClone[] = [];
  const remaining = maxClones - existingClones.length;
  if (remaining <= 0) return clones;

  const sorted = [...entries].sort((a, b) => a.lines.length - b.lines.length);

  for (let i = 0; i < sorted.length && clones.length < remaining; i++) {
    for (let j = i + 1; j < sorted.length && clones.length < remaining; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.lines.length > a.lines.length * MAX_LINE_RATIO) break;
      if (a.hash === b.hash) continue;
      if (a.file === b.file && a.start_line === b.start_line) continue;

      const alreadyFound = existingClones.some((c) =>
        (c.symbol_a.file === a.file && c.symbol_a.start_line === a.start_line &&
         c.symbol_b.file === b.file && c.symbol_b.start_line === b.start_line),
      );
      if (alreadyFound) continue;

      const { similarity, sharedLines } = computeSimilarity(a.lines, b.lines);
      if (similarity >= minSimilarity && sharedLines >= minLines) {
        clones.push(buildClone(a, b, similarity, sharedLines));
      }
    }
  }

  return clones;
}

/**
 * Find code clones: pairs of symbols with similar normalized source.
 * Uses hash-based bucketing for O(n) average case instead of O(n²) all-pairs.
 */
export async function findClones(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    min_similarity?: number | undefined;
    min_lines?: number | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<CloneResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const minSimilarity = options?.min_similarity ?? DEFAULT_MIN_SIMILARITY;
  const minLines = options?.min_lines ?? MIN_CLONE_LINES;
  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  const entries = prepareEntries(index.symbols, minLines, includeTests, filePattern);
  const exactClones = findExactMatches(entries, minSimilarity, minLines, MAX_CLONES);
  const nearClones = findNearMatches(entries, exactClones, minSimilarity, minLines, MAX_CLONES);

  const allClones = [...exactClones, ...nearClones];
  allClones.sort((a, b) => b.similarity - a.similarity);

  return {
    clones: allClones.slice(0, MAX_CLONES),
    scanned_symbols: entries.length,
    threshold: minSimilarity,
  };
}
