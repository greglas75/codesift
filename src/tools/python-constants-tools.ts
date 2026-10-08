import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
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
  },
): Promise<ConstantResolutionResult> {
  // Resolution reads the root and the file list (to load files and resolve imports) plus the
  // symbols NAMED `symbolName` — never the rest. The summary and one `WHERE name = ?` read
  // replace the materialised index. `source` is kept: function-default resolution parses it.
  const index = await getIndexSummary(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const named = await findRepoSymbols(
    repo,
    { name: symbolName, withSource: true },
    { skipFreshness: true },
  );
  const candidates = named
    .filter((symbol) => symbol.file.endsWith(".py"))
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
