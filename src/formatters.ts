/**
 * Stable formatter facade.
 *
 * Domain implementations live in focused modules; this path remains the
 * compatibility entrypoint for existing imports and lazy tool loaders.
 */
export {
  formatTable,
  formatSearchSymbols,
  formatFileTree,
  formatFileOutline,
  formatSearchPatterns,
  formatDeadCode,
  formatComplexity,
  formatClones,
  formatHotspots,
  formatRepoOutline,
  formatSuggestQueries,
  formatSecrets,
  formatConversations,
  formatRoles,
  formatAssembleContext,
} from "./formatters-core.js";

export {
  formatCallTree,
  formatTraceRoute,
  formatDiffOutline,
  formatChangedSymbols,
  formatImpactAnalysis,
  formatKnowledgeMap,
  formatCommunities,
} from "./formatters-graph.js";

export {
  formatReviewDiff,
  formatPerfHotspots,
  formatFanInFanOut,
  formatCoChange,
  formatArchitectureSummary,
} from "./formatters-analysis.js";

export {
  formatNextjsComponents,
  formatNextjsRouteMap,
  formatNextjsMetadataAudit,
  formatNextjsAuditServerActions,
  formatNextjsApiContract,
  formatNextjsBoundaryAnalyzer,
  formatNextjsDataFlow,
  formatNextjsMiddlewareCoverage,
  formatFrameworkAudit,
  formatNextjsLinkIntegrity,
} from "./formatters-nextjs.js";
