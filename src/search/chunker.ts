import type { CodeChunk } from "../types.js";

// ---------------------------------------------------------------------------
// Chunking constants
// ---------------------------------------------------------------------------

const CHUNK_TOKENS = 400;           // target tokens per chunk
const OVERLAP_TOKENS = 80;          // overlap between consecutive chunks
const CHARS_PER_TOKEN = 4;          // rough approximation

const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;   // 1600
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 320

const MAX_FILE_BYTES = 50_000;      // skip files > 50KB

// Extensions that carry no semantic code value for embedding
const SKIP_EXTENSIONS = new Set([
  ".json", ".lock", ".md", ".yaml", ".yml",
  ".env", ".txt", ".svg", ".png", ".wasm",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a file's content into overlapping text chunks suitable for embedding.
 *
 * Returns an empty array when the file should be skipped (binary, too large,
 * non-code extension).
 */
export function chunkFile(
  file: string,
  content: string,
  repo: string,
): CodeChunk[] {
  // Skip non-code file types
  const dotIdx = file.lastIndexOf(".");
  const ext = dotIdx !== -1 ? file.slice(dotIdx) : "";
  if (SKIP_EXTENSIONS.has(ext)) return [];

  // Skip files that are too large
  if (content.length > MAX_FILE_BYTES) return [];

  // Skip binary files (presence of null bytes is a reliable signal)
  if (content.includes("\0")) return [];

  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines === 0) return [];

  // Pre-compute cumulative character offsets per line (1-based line indices)
  // offsets[i] = char offset of the START of line (i+1) (0-indexed array)
  const lineStartOffset: number[] = new Array(totalLines);
  let offset = 0;
  for (let i = 0; i < totalLines; i++) {
    lineStartOffset[i] = offset;
    offset += (lines[i]?.length ?? 0) + 1; // +1 for the '\n'
  }
  const totalChars = content.length;

  const chunks: CodeChunk[] = [];
  let chunkStart = 0; // char offset of current window start

  while (chunkStart < totalChars) {
    const chunkEnd = Math.min(chunkStart + CHUNK_CHARS, totalChars);
    const text = content.slice(chunkStart, chunkEnd);

    // Map char offsets to 1-based line numbers
    const startLine = charOffsetToLine(chunkStart, lineStartOffset) + 1;
    const endLine = charOffsetToLine(chunkEnd - 1, lineStartOffset) + 1;

    const tokenCount = Math.ceil(text.length / CHARS_PER_TOKEN);

    const id = `${repo}:${file}:${startLine}`;
    chunks.push({ id, file, startLine, endLine, text, tokenCount });

    // Advance window by (CHUNK_CHARS - OVERLAP_CHARS) to create overlap
    const advance = CHUNK_CHARS - OVERLAP_CHARS;
    chunkStart += advance;

    // If the remaining content fits entirely in one more chunk, we're done
    if (chunkStart >= totalChars) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Binary-search lineStartOffset to find the 0-based line index that contains
 * the given character offset.
 */
function charOffsetToLine(charOffset: number, lineStartOffset: number[]): number {
  let lo = 0;
  let hi = lineStartOffset.length - 1;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const lineStart = lineStartOffset[mid];
    if (lineStart !== undefined && lineStart <= charOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}
