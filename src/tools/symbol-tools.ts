/**
 * Stable public facade for symbol-oriented tools.
 *
 * Deferred tool loaders and external consumers import this exact module path.
 * Keep exports explicit so internal split helpers cannot accidentally become public.
 */
export {
  AmbiguousSymbolIdError,
  extractSymbolNameGuess,
  findSimilarSymbols,
  getSymbol,
  getSymbols,
  isAmbiguousSymbolIdError,
  resolveSymbolIdExact,
} from "./symbol-lookup-tools.js";
export type { SymbolIdAmbiguity } from "./symbol-lookup-tools.js";

export {
  findReferences,
  findReferencesBatch,
} from "./symbol-reference-tools.js";
export type {
  ReferenceScanCoverage,
  ReferenceScanSink,
} from "./symbol-reference-tools.js";

export {
  findAndShow,
  formatBundleCompact,
  formatRefsCompact,
  formatSymbolCompact,
  formatSymbolsCompact,
  getContextBundle,
} from "./symbol-context-tools.js";
export type {
  ContextBundle,
  ReactContext,
} from "./symbol-context-tools.js";

export {
  findDeadCode,
  findUnusedImports,
} from "./symbol-analysis-tools.js";
export type {
  DeadCodeCandidate,
  DeadCodeResult,
  UnusedImport,
  UnusedImportsResult,
} from "./symbol-analysis-tools.js";
