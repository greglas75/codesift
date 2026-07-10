/** Stable facade for Kotlin-specific analysis capabilities. */
export {
  findExtensionFunctions,
  type ExtensionFunctionResult,
} from "./kotlin-extension-tools.js";
export {
  analyzeSealedHierarchy,
  type SealedHierarchyResult,
} from "./kotlin-sealed-tools.js";
export {
  traceSuspendChain,
  type SuspendChainResult,
  type SuspendDispatcherTransition,
  type SuspendWarning,
} from "./kotlin-suspend-tools.js";
export {
  analyzeKmpDeclarations,
  type KmpAnalysisResult,
  type KmpMatchedDeclaration,
  type KmpMissingDeclaration,
  type KmpOrphanDeclaration,
} from "./kotlin-kmp-tools.js";
export {
  traceFlowChain,
  type FlowChainResult,
} from "./kotlin-flow-tools.js";
