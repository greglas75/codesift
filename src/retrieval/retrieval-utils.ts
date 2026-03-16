import type { CodeChunk } from "../types.js";
import { isTestFile } from "../utils/test-file.js";
import {
  CHARS_PER_TOKEN,
  RRF_K,
  ADJACENCY_GAP,
  LINE_NUMBER_PAD,
  QUERY_DECOMPOSE_THRESHOLD,
  SPLIT_WINDOW_LO,
  SPLIT_WINDOW_HI,
} from "./retrieval-constants.js";

/**
 * Estimate token count from a string. ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Filter embedding entries by file path substring and/or test file exclusion.
 * Uses a lookup map to resolve the file path for each embedding ID.
 */
export function filterEmbeddingsByFile(
  embeddings: Map<string, Float32Array>,
  fileLookup: Map<string, string | undefined>,
  fileFilter: string | undefined,
  excludeTests: boolean,
): Map<string, Float32Array> {
  if (!fileFilter && !excludeTests) return embeddings;
  return new Map([...embeddings.entries()].filter(([id]) => {
    const file = fileLookup.get(id);
    if (!file) return false;
    if (fileFilter && !file.includes(fileFilter)) return false;
    if (excludeTests && isTestFile(file)) return false;
    return true;
  }));
}

/**
 * Compute RRF scores from multiple embedding query vectors against filtered embeddings.
 * Each vector produces a ranked list; scores are accumulated via RRF formula.
 */
export function computeRRFScores(
  vecs: number[][],
  filteredEmbeddings: Map<string, Float32Array>,
  cosSim: (a: Float32Array, b: Float32Array) => number,
): Map<string, number> {
  const rrfScores = new Map<string, number>();
  for (const vec of vecs) {
    if (!vec) continue;
    const qEmbed = new Float32Array(vec);
    const subScores: Array<{ id: string; score: number }> = [];
    for (const [id, chunkVec] of filteredEmbeddings) {
      if (chunkVec.length === qEmbed.length) {
        subScores.push({ id, score: cosSim(qEmbed, chunkVec) });
      }
    }
    subScores.sort((a, b) => b.score - a.score);
    subScores.forEach((s, rank) => {
      rrfScores.set(s.id, (rrfScores.get(s.id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return rrfScores;
}

export type ChunkEntry = { startLine: number; endLine: number; text: string };

/**
 * Group top chunk IDs by file, merge overlapping/adjacent chunks, and format
 * as numbered plain text sections.
 */
export function formatChunksAsText(
  topIds: string[],
  chunks: Map<string, CodeChunk>,
  excludeTests: boolean,
): string {
  const byFile = new Map<string, ChunkEntry[]>();
  for (const id of topIds) {
    const chunk = chunks.get(id);
    if (!chunk) continue;
    if (excludeTests && isTestFile(chunk.file)) continue;
    const existing = byFile.get(chunk.file) ?? [];
    existing.push({ startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
    byFile.set(chunk.file, existing);
  }

  const sections: string[] = ["The following code sections were retrieved:"];
  for (const [file, fileChunks] of byFile) {
    fileChunks.sort((a, b) => a.startLine - b.startLine);
    const merged: ChunkEntry[] = [];
    for (const chunk of fileChunks) {
      const last = merged[merged.length - 1];
      if (last && chunk.startLine <= last.endLine + ADJACENCY_GAP) {
        if (chunk.endLine > last.endLine) {
          const overlapLines = last.endLine - chunk.startLine + 1;
          const newLines = chunk.text.split("\n").slice(overlapLines);
          last.text = last.text + "\n" + newLines.join("\n");
          last.endLine = chunk.endLine;
        }
      } else {
        merged.push({ startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
      }
    }
    sections.push(`Path: ${file}`);
    for (const chunk of merged) {
      const lines = chunk.text.split("\n");
      const numbered = lines.map((line, i) => {
        const lineNo = String(chunk.startLine + i).padStart(LINE_NUMBER_PAD, " ");
        return `${lineNo}\t${line}`;
      }).join("\n");
      sections.push(numbered);
    }
    sections.push("...");
  }

  return sections.join("\n");
}

/**
 * Split a long query into sub-queries at natural connectors for RRF merging.
 */
export function decomposeQuery(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length <= QUERY_DECOMPOSE_THRESHOLD) return [query];

  const splitWords = new Set(["and", "or", "from", "to", "with", "using", "for", "via", "then"]);
  const lo = Math.floor(words.length * SPLIT_WINDOW_LO);
  const hi = Math.floor(words.length * SPLIT_WINDOW_HI);

  for (let i = lo; i <= hi; i++) {
    if (splitWords.has((words[i] ?? "").toLowerCase())) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i + 1).join(" ");
      if (a.trim() && b.trim()) return [a, b];
    }
  }

  const mid = Math.floor(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/**
 * Truncate symbol source to a character limit, preserving the rest of the symbol object.
 */
export function truncateSymbolSource<T extends { source?: string }>(
  sym: T,
  limit: number,
): T {
  if (limit > 0 && sym.source && sym.source.length > limit) {
    return { ...sym, source: sym.source.slice(0, limit) };
  }
  return sym;
}

/**
 * Race a promise against a timeout. Rejects with a descriptive error on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}
