/**
 * Stable public facade for plan-turn parsing, routing, and formatting.
 * Keep this exact module path for lazy MCP registration and test mocks.
 */

export { parseQuery } from "./plan-turn/query-parser.js";
export { _resetPlanTurnCaches, planTurn } from "./plan-turn/orchestrator.js";
export { safeReadGitHead, isStaleIndex } from "./plan-turn/stale-index.js";
export { formatPlanTurnResult } from "./plan-turn/formatter.js";
export type {
  FileRecommendation,
  GapAnalysis,
  ParsedQuery,
  PlanTurnMetadata,
  PlanTurnResult,
  SymbolRecommendation,
} from "./plan-turn/types.js";
