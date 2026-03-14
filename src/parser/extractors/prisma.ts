/**
 * Prisma schema extractor — regex-based parser (no tree-sitter grammar).
 *
 * Extracts:
 * - `enum Name { ... }`    → kind: "enum"
 * - `model Name { ... }`   → kind: "class"
 * - `type Name { ... }`    → kind: "type"
 *
 * Prisma schemas define the data model and are valuable for understanding
 * entity structures, enums, and relationships.
 */

import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

const MAX_SOURCE_LENGTH = 5000;

/**
 * Matches top-level Prisma blocks: enum, model, type.
 * Captures: keyword (enum/model/type) and name.
 */
const BLOCK_START_RE = /^(enum|model|type)\s+(\w+)\s*\{/;

/**
 * Extract symbols from a Prisma schema file without tree-sitter.
 */
export function extractPrismaSymbols(
  source: string,
  filePath: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = BLOCK_START_RE.exec(line.trim());

    if (match) {
      const keyword = match[1]!;
      const name = match[2]!;
      const startLine = i + 1; // 1-based

      // Find matching closing brace, tracking nesting
      let braceDepth = 1;
      let endLineIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        const scanLine = lines[j]!;
        for (const ch of scanLine) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }
        if (braceDepth === 0) {
          endLineIdx = j;
          break;
        }
      }

      // If braces never balanced, use last line
      if (braceDepth !== 0) {
        endLineIdx = lines.length - 1;
      }

      const endLine = endLineIdx + 1; // 1-based

      // Extract source text for the block
      const blockLines = lines.slice(i, endLineIdx + 1);
      const blockSource = blockLines.join("\n");

      // Map Prisma keyword to symbol kind
      let kind: "enum" | "class" | "type";
      switch (keyword) {
        case "enum":
          kind = "enum";
          break;
        case "model":
          kind = "class";
          break;
        case "type":
          kind = "type";
          break;
        default:
          kind = "type";
      }

      // Build docstring from comments above the block
      const docstring = extractDocstring(lines, i);

      const sym: CodeSymbol = {
        id: makeSymbolId(repo, filePath, name, startLine),
        repo,
        name,
        kind,
        file: filePath,
        start_line: startLine,
        end_line: endLine,
        signature: `${keyword} ${name}`,
        source: blockSource.length > MAX_SOURCE_LENGTH
          ? blockSource.slice(0, MAX_SOURCE_LENGTH) + "..."
          : blockSource,
        tokens: tokenizeIdentifier(name),
      };
      if (docstring) sym.docstring = docstring;
      symbols.push(sym);

      // Jump past the block
      i = endLineIdx + 1;
    } else {
      i++;
    }
  }

  return symbols;
}

/**
 * Extract comment lines immediately above a block as a docstring.
 */
function extractDocstring(lines: string[], blockLineIdx: number): string | undefined {
  const commentLines: string[] = [];
  for (let j = blockLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trim();
    if (trimmed.startsWith("//")) {
      commentLines.unshift(trimmed);
    } else if (trimmed === "") {
      // Allow blank lines within comment block
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }
  return commentLines.length > 0 ? commentLines.join("\n") : undefined;
}
