import type { CodeIndex } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { matchesConstantFilePattern } from "../utils/constant-file-pattern.js";
import { resolveConstantSymbol } from "./python-constants/constant-match.js";
import { resolveFunctionDefaults } from "./python-constants/function-defaults.js";
import type {
  ConstantResolutionMatch,
  ConstantResolutionResult,
  ResolutionState,
} from "./python-constants/model.js";

export type {
  ConstantResolutionMatch,
  ConstantResolutionResult,
  PythonLiteralKind,
  PythonLiteralObject,
  PythonLiteralValue,
  ResolutionHop,
  ResolvedDefaultParameter,
} from "./python-constants/model.js";

const MAX_DEFAULT_DEPTH = 8;

export async function resolveConstantValue(
  repo: string,
  symbolName: string,
  options?: {
    file_pattern?: string;
    max_depth?: number;
    /** When set, skips a second getCodeIndex (multi-language orchestrator). */
    index?: CodeIndex;
  },
): Promise<ConstantResolutionResult> {
  const index = options?.index ?? await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const candidates = index.symbols
    .filter((symbol) => symbol.file.endsWith(".py"))
    .filter((symbol) => symbol.name === symbolName)
    .filter((symbol) => matchesConstantFilePattern(symbol.file, options?.file_pattern))
    .filter((symbol) => symbol.kind === "constant" || symbol.kind === "function" || symbol.kind === "method")
    .sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  const state: ResolutionState = {
    index,
    fileCache: new Map(),
    visited: new Set(),
    maxDepth: options?.max_depth ?? MAX_DEFAULT_DEPTH,
  };

  const matches: ConstantResolutionMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "constant") {
      matches.push(await resolveConstantSymbol(candidate, state));
    } else {
      matches.push(await resolveFunctionDefaults(candidate, state));
    }
  }

  return {
    query: symbolName,
    matches,
  };
}
