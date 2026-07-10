import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SealedHierarchyResult {
  sealed_class: { name: string; file: string; start_line: number; kind: string };
  subtypes: Array<{ name: string; file: string; start_line: number; kind: string }>;
  when_blocks: Array<{
    file: string;
    line: number;
    branches_found: string[];
    branches_missing: string[];
    is_exhaustive: boolean;
  }>;
  total_subtypes: number;
  total_when_blocks: number;
  all_exhaustive: boolean;
}

function findSealedSymbol(index: CodeIndex, sealedClassName: string): CodeSymbol | undefined {
  return index.symbols.find(
    (symbol) => symbol.name === sealedClassName
      && (symbol.kind === "class" || symbol.kind === "interface")
      && symbol.source?.includes("sealed"),
  );
}

function collectSubtypes(
  index: CodeIndex,
  sealedClassName: string,
): SealedHierarchyResult["subtypes"] {
  const escapedClassName = escapeRegExp(sealedClassName);
  const subtypePattern = new RegExp(
    `:\\s*(?:[\\w<>,\\s]+,\\s*)?${escapedClassName}\\s*[({,)]|:\\s*${escapedClassName}\\s*$`,
  );
  return index.symbols.flatMap((symbol) => {
    const isCandidate = (symbol.kind === "class" || symbol.kind === "interface")
      && symbol.name !== sealedClassName
      && symbol.source !== undefined
      && subtypePattern.test(symbol.source);
    return isCandidate
      ? [{ name: symbol.name, file: symbol.file, start_line: symbol.start_line, kind: symbol.kind }]
      : [];
  });
}

function findClosingBrace(source: string, blockStart: number): number {
  let depth = 1;
  let blockEnd = blockStart;
  let quote: "\"" | "'" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = blockStart; index < source.length && depth > 0; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
    } else if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
    } else if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index++;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "{") depth++;
    else if (char === "}") depth--;
    blockEnd = index;
  }
  return blockEnd;
}

function analyzeWhenSource(
  source: string,
  file: string,
  subtypeNames: Set<string>,
): SealedHierarchyResult["when_blocks"] {
  const whenBlocks: SealedHierarchyResult["when_blocks"] = [];
  const whenPattern = /\bwhen\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = whenPattern.exec(source)) !== null) {
    const blockEnd = findClosingBrace(source, match.index + match[0].length);
    const blockContent = source.slice(match.index, blockEnd + 1);
    const branchesFound = [...subtypeNames].filter((subtypeName) =>
      new RegExp(`\\b(?:is\\s+)?${escapeRegExp(subtypeName)}\\b`).test(blockContent));
    if (branchesFound.length === 0) continue;
    const branchesMissing = [...subtypeNames].filter(
      (subtypeName) => !branchesFound.includes(subtypeName),
    );
    whenBlocks.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      branches_found: branchesFound.sort(),
      branches_missing: branchesMissing.sort(),
      is_exhaustive: branchesMissing.length === 0,
    });
  }
  return whenBlocks;
}

async function collectWhenBlocks(
  index: CodeIndex,
  subtypeNames: Set<string>,
): Promise<SealedHierarchyResult["when_blocks"]> {
  const kotlinFiles = index.files.filter((entry) => /\.kts?$/.test(entry.path));
  const blocksByFile = await Promise.all(kotlinFiles.map(async (file) => {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read indexed Kotlin file "${file.path}": ${message}`);
    }
    return analyzeWhenSource(source, file.path, subtypeNames);
  }));
  return blocksByFile.flat();
}

/** Analyze a sealed class/interface hierarchy and its when blocks. */
export async function analyzeSealedHierarchy(
  repo: string,
  sealedClassName: string,
): Promise<SealedHierarchyResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  const sealedSymbol = findSealedSymbol(index, sealedClassName);
  if (!sealedSymbol) {
    throw new Error(
      `Sealed class/interface "${sealedClassName}" not found. Ensure the file is indexed.`,
    );
  }
  const subtypes = collectSubtypes(index, sealedClassName);
  const whenBlocks = await collectWhenBlocks(index, new Set(subtypes.map((subtype) => subtype.name)));
  return {
    sealed_class: {
      name: sealedSymbol.name,
      file: sealedSymbol.file,
      start_line: sealedSymbol.start_line,
      kind: sealedSymbol.kind,
    },
    subtypes,
    when_blocks: whenBlocks,
    total_subtypes: subtypes.length,
    total_when_blocks: whenBlocks.length,
    all_exhaustive: whenBlocks.length > 0 && whenBlocks.every((block) => block.is_exhaustive),
  };
}
