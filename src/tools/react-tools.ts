/**
 * React-specific code intelligence tools.
 *
 * Compatibility facade: implementation lives in per-capability modules.
 */
export { REACT_STDLIB_HOOKS } from "./react-shared-tools.js";

export {
  buildJsxAdjacency,
  buildComponentTree,
  extractJsxComponents,
  buildReverseAdjacency,
  computePropChainDepth,
  traceComponentTree,
} from "./react-component-tree-tools.js";
export type {
  TraceComponentTreeOptions,
} from "./react-component-tree-tools.js";

export {
  findSuspenseAncestor,
  findLazyComponentsWithoutSuspense,
} from "./react-suspense-tools.js";
export type { LazyWithoutSuspense } from "./react-suspense-tools.js";

export {
  extractHookCalls,
  extractHookNames,
  findRuleOfHooksViolations,
  analyzeHooks,
} from "./react-hooks-tools.js";
export type {
  HookCall,
  HookInventoryEntry,
  HookUsageSummary,
  AnalyzeHooksResult,
} from "./react-hooks-tools.js";

export {
  findRenderRisks,
  formatRendersMarkdown,
  analyzeRenders,
} from "./react-render-tools.js";
export type {
  RenderRisk,
  RenderAnalysisEntry,
  AnalyzeRendersResult,
} from "./react-render-tools.js";

export { buildContextGraph } from "./react-context-tools.js";
export type {
  ReactContextInfo,
  ContextGraph,
} from "./react-context-tools.js";

export { auditCompilerReadiness } from "./react-compiler-tools.js";
export type { CompilerReadinessResult } from "./react-compiler-tools.js";

export { reactQuickstart } from "./react-quickstart-tools.js";
export type { ReactQuickstartResult } from "./react-quickstart-tools.js";
