/**
 * Markdown symbol extractor — custom parser (no tree-sitter).
 *
 * Extracts:
 * - Headings (# ... ######) as "section" kind with hierarchical parent refs
 * - YAML frontmatter (--- delimited) as "metadata" kind
 *
 * Section boundaries span from heading to next heading of same/higher level (or EOF).
 */

import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Extract symbols from a markdown file without tree-sitter.
 */
export function extractMarkdownSymbols(
  source: string,
  filePath: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = source.split("\n");
  const totalLines = lines.length;

  // --- Frontmatter extraction ---
  let frontmatterEndLine = -1; // -1 = no frontmatter
  if (totalLines > 0 && lines[0]!.trim() === "---") {
    for (let i = 1; i < totalLines; i++) {
      if (lines[i]!.trim() === "---") {
        frontmatterEndLine = i; // 0-indexed
        break;
      }
    }
  }

  if (frontmatterEndLine > 0) {
    const fmLines = lines.slice(0, frontmatterEndLine + 1);
    const fmSource = fmLines.join("\n");
    const contentLines = lines.slice(1, frontmatterEndLine);
    const summary = contentLines
      .map((ln) => ln.trim())
      .filter(Boolean)
      .join("; ")
      .slice(0, 150);

    const sym: CodeSymbol = {
      id: makeSymbolId(repo, filePath, "frontmatter", 1),
      repo,
      name: "frontmatter",
      kind: "metadata",
      file: filePath,
      start_line: 1,
      end_line: frontmatterEndLine + 1, // 1-based
      source: fmSource.length > MAX_SOURCE_LENGTH
        ? fmSource.slice(0, MAX_SOURCE_LENGTH) + "..."
        : fmSource,
      tokens: ["frontmatter"],
    };
    if (summary) sym.docstring = summary;
    symbols.push(sym);
  }

  // --- Collect headings, skipping fenced code blocks ---
  const headings: Array<{ lineIdx: number; level: number; text: string }> = [];
  let inFencedBlock = false;

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (FENCE_RE.test(trimmed)) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;

    const match = HEADING_RE.exec(line);
    if (match) {
      headings.push({
        lineIdx: i,
        level: match[1]!.length,
        text: match[2]!.trim(),
      });
    }
  }

  if (headings.length === 0) return symbols;

  // --- Compute section end lines (0-indexed, inclusive) ---
  const headingEndLines: number[] = [];
  for (let idx = 0; idx < headings.length; idx++) {
    const { level } = headings[idx]!;
    let end = totalLines - 1; // default: EOF
    for (let nextIdx = idx + 1; nextIdx < headings.length; nextIdx++) {
      if (headings[nextIdx]!.level <= level) {
        end = headings[nextIdx]!.lineIdx - 1;
        break;
      }
    }
    headingEndLines.push(end);
  }

  // --- Build parent stack for hierarchy ---
  // Stack: Array of { level, qualifiedName, symbolId }
  const parentStack: Array<{
    level: number;
    qualifiedName: string;
    symbolId: string;
  }> = [];

  for (let idx = 0; idx < headings.length; idx++) {
    const { lineIdx, level, text } = headings[idx]!;
    const endLineIdx = headingEndLines[idx]!;

    // Pop stack until we find a parent with lower level (higher heading)
    while (parentStack.length > 0 && parentStack[parentStack.length - 1]!.level >= level) {
      parentStack.pop();
    }

    // Build qualified name (hierarchical path)
    let qualifiedName: string;
    let parentId: string | undefined;
    if (parentStack.length > 0) {
      const parent = parentStack[parentStack.length - 1]!;
      qualifiedName = `${parent.qualifiedName}/${text}`;
      parentId = parent.symbolId;
    } else {
      qualifiedName = text;
      parentId = undefined;
    }

    // Extract section source
    const sectionLines = lines.slice(lineIdx, endLineIdx + 1);
    const sectionSource = sectionLines.join("\n");

    // Build summary from first content after heading
    const summary = buildSectionSummary(lines, lineIdx, endLineIdx);

    const startLine = lineIdx + 1; // 1-based
    const endLine = endLineIdx + 1; // 1-based
    const symId = makeSymbolId(repo, filePath, qualifiedName, startLine);

    const sym: CodeSymbol = {
      id: symId,
      repo,
      name: text,
      kind: "section",
      file: filePath,
      start_line: startLine,
      end_line: endLine,
      signature: `${"#".repeat(level)} ${text}`,
      source: sectionSource.length > MAX_SOURCE_LENGTH
        ? sectionSource.slice(0, MAX_SOURCE_LENGTH) + "..."
        : sectionSource,
      tokens: tokenizeIdentifier(text.replace(/[^a-zA-Z0-9_]/g, " ").replace(/\s+/g, "_")),
    };
    if (summary) sym.docstring = summary;
    if (parentId) sym.parent = parentId;
    symbols.push(sym);

    // Push onto stack for child headings
    parentStack.push({ level, qualifiedName, symbolId: symId });
  }

  return symbols;
}

/**
 * Build a summary for a markdown section.
 *
 * Rules:
 * - Table (starts with |) → "Table: N rows"
 * - Code block (``` or ~~~) → "Code: language, N lines"
 * - Otherwise → first non-empty paragraph, truncated to 150 chars
 */
function buildSectionSummary(
  lines: string[],
  headingLineIdx: number,
  endLineIdx: number,
): string {
  const contentStart = headingLineIdx + 1;
  if (contentStart > endLineIdx) return "";

  // Skip blank lines after heading
  let firstContent = contentStart;
  while (firstContent <= endLineIdx && !lines[firstContent]!.trim()) {
    firstContent++;
  }
  if (firstContent > endLineIdx) return "";

  const firstLine = lines[firstContent]!.trim();

  // Check for table
  if (firstLine.startsWith("|")) {
    let tableRows = 0;
    for (let j = firstContent; j <= endLineIdx; j++) {
      const stripped = lines[j]!.trim();
      if (stripped.startsWith("|")) {
        // Skip separator rows (|---|---|)
        if (!/^\|[\s\-:|]+\|$/.test(stripped)) {
          tableRows++;
        }
      } else if (!stripped) {
        continue;
      } else {
        break;
      }
    }
    return `Table: ${tableRows} rows`;
  }

  // Check for code block
  const codeMatch = FENCE_RE.exec(firstLine);
  if (codeMatch) {
    const langMatch = /^(?:`{3,}|~{3,})\s*([\w+-]*)/.exec(firstLine);
    const lang = langMatch?.[1] || "text";
    let codeLines = 0;
    const fenceChar = codeMatch[1]!.slice(0, 3);
    for (let j = firstContent + 1; j <= endLineIdx; j++) {
      if (lines[j]!.trim().startsWith(fenceChar)) break;
      codeLines++;
    }
    return `Code: ${lang}, ${codeLines} lines`;
  }

  // Default: first non-empty paragraph
  const paraLines: string[] = [];
  for (let j = firstContent; j <= endLineIdx; j++) {
    const stripped = lines[j]!.trim();
    if (stripped && !stripped.startsWith("#")) {
      paraLines.push(stripped);
    } else if (!stripped && paraLines.length > 0) {
      break;
    } else if (stripped.startsWith("#")) {
      break;
    }
  }
  return paraLines.join(" ").slice(0, 150);
}
