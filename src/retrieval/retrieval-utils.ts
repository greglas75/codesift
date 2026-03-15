import type { CodeChunk } from "../types.js";
import { isTestFile } from "../utils/test-file.js";

/**
 * Estimate token count from a string. ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  const rrfK = 60;
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
      rrfScores.set(s.id, (rrfScores.get(s.id) ?? 0) + 1 / (rrfK + rank + 1));
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
      if (last && chunk.startLine <= last.endLine + 5) {
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
        const lineNo = String(chunk.startLine + i).padStart(6, " ");
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
 * Queries ≤ 8 words are returned as-is.
 */
export function decomposeQuery(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length <= 8) return [query];

  const splitWords = new Set(["and", "or", "from", "to", "with", "using", "for", "via", "then"]);
  const lo = Math.floor(words.length * 0.35);
  const hi = Math.floor(words.length * 0.65);

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
