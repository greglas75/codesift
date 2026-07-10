import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

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
  const subtypePattern = new RegExp(
    `:\\s*(?:[\\w<>,\\s]+,\\s*)?${sealedClassName}\\s*[({,)]|:\\s*${sealedClassName}\\s*$`,
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
  for (let index = blockStart; index < source.length && depth > 0; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") depth--;
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
      new RegExp(`\\b(?:is\\s+)?${subtypeName}\\b`).test(blockContent));
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
  const whenBlocks: SealedHierarchyResult["when_blocks"] = [];
  for (const file of index.files.filter((entry) => /\.kts?$/.test(entry.path))) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    whenBlocks.push(...analyzeWhenSource(source, file.path, subtypeNames));
  }
  return whenBlocks;
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
