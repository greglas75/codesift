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

/**
 * Chunk a file at symbol boundaries instead of fixed character count.
 * Each symbol = one chunk. Preamble (imports) = separate chunk.
 * Falls back to chunkFile when no symbols provided.
 */
export function chunkBySymbols(
  file: string,
  content: string,
  repo: string,
  symbols: Array<{ name: string; start_line: number; end_line: number }>,
): CodeChunk[] {
  if (symbols.length === 0) return chunkFile(file, content, repo);

  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];

  // Sort symbols by start_line
  const sorted = [...symbols].sort((a, b) => a.start_line - b.start_line);

  // Preamble: lines before first symbol (imports, comments)
  const firstStart = sorted[0]?.start_line ?? 1;
  if (firstStart > 1) {
    const text = lines.slice(0, firstStart - 1).join("\n");
    if (text.trim().length > 0) {
      chunks.push({
        id: `${repo}:${file}:1`,
        file,
        startLine: 1,
        endLine: firstStart - 1,
        text,
        tokenCount: Math.ceil(text.length / CHARS_PER_TOKEN),
      });
    }
  }

  // One chunk per symbol
  for (const sym of sorted) {
    const start = sym.start_line - 1; // 0-based
    const end = Math.min(sym.end_line, lines.length); // 1-based inclusive
    const symLines = lines.slice(start, end);
    const text = symLines.join("\n");

    if (text.trim().length === 0) continue;

    // Cap very large symbols
    const cappedText = text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text;

    chunks.push({
      id: `${repo}:${file}:${sym.start_line}`,
      file,
      startLine: sym.start_line,
      endLine: end,
      text: cappedText,
      tokenCount: Math.ceil(cappedText.length / CHARS_PER_TOKEN),
    });
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
