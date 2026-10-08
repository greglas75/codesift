import type { CodeIndex, CodeSymbol } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { buildNormalizedPathMap } from "../utils/import-graph.js";
import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import { matchesConstantFilePattern } from "../utils/constant-file-pattern.js";
import type {
  ConstantResolutionMatch,
  ConstantResolutionResult,
} from "./python-constants-tools.js";
import {
  disposeTypeScriptFileContexts,
  isTypeScriptFile,
} from "./typescript-constants/file-context.js";
import {
  resolveConstantSymbol,
  resolveFunctionDefaults,
} from "./typescript-constants/symbol-resolver.js";
import type { ResolutionState } from "./typescript-constants/types.js";

const MAX_DEFAULT_DEPTH = 8;

export async function resolveTypeScriptConstantValue(
  repo: string,
  symbolName: string,
  options?: {
    file_pattern?: string;
    max_depth?: number;
    /** When set, skips a second index read (multi-language orchestrator). */
    index?: CodeIndex;
  },
): Promise<ConstantResolutionResult> {
  // Without an orchestrator-supplied index this reads the SUMMARY (root + files, for the path map
  // and file reads) and only the symbols NAMED `symbolName` — the one predicate every candidate must
  // pass — instead of materialising the whole index (ADR-004 stage 2). Source is requested because
  // function-default resolution parses the candidate's body.
  const index = options?.index ?? await getIndexSummary(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const parser = await getParser("typescript");
  if (!parser) {
    throw new Error("TypeScript parser unavailable");
  }

  const named: CodeSymbol[] = options?.index
    ? options.index.symbols.filter((symbol) => symbol.name === symbolName)
    : await findRepoSymbols(repo, { withSource: true, name: symbolName }, { skipFreshness: true });

  const candidates = named
    .filter((symbol) => isTypeScriptFile(symbol.file))
    .filter((symbol) => matchesConstantFilePattern(symbol.file, options?.file_pattern))
    .filter((symbol) => ["constant", "variable", "function", "method", "hook", "component"].includes(symbol.kind))
    .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  const state: ResolutionState = {
    index,
    parser,
    fileCache: new Map(),
    retiredTrees: [],
    normalizedPathMap: buildNormalizedPathMap(index),
    visited: new Set(),
    maxDepth: options?.max_depth ?? MAX_DEFAULT_DEPTH,
  };

  const matches: ConstantResolutionMatch[] = [];
  try {
    for (const candidate of candidates) {
      if (candidate.kind === "constant" || candidate.kind === "variable") {
        matches.push(await resolveConstantSymbol(candidate, state));
      } else {
        matches.push(await resolveFunctionDefaults(candidate, state));
      }
    }

    return {
      query: symbolName,
      matches,
    };
  } finally {
    disposeTypeScriptFileContexts(state);
  }
}
