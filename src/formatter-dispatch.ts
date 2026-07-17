/**
 * Tool-name formatter registry.
 *
 * Keeping the map separate from the compatibility facade lets tool groups
 * dispatch by MCP name without importing every domain module themselves.
 */
import {
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
import {
  formatCallTree,
  formatTraceRoute,
  formatDiffOutline,
  formatChangedSymbols,
  formatImpactAnalysis,
  formatKnowledgeMap,
  formatCommunities,
} from "./formatters-graph.js";
import {
  formatReviewDiff,
  formatPerfHotspots,
  formatFanInFanOut,
  formatCoChange,
  formatArchitectureSummary,
} from "./formatters-analysis.js";
import {
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

export const FORMATTER_DISPATCH = {
  search_symbols: formatSearchSymbols,
  get_file_tree: formatFileTree,
  get_file_outline: formatFileOutline,
  search_patterns: formatSearchPatterns,
  find_dead_code: formatDeadCode,
  analyze_complexity: formatComplexity,
  find_clones: formatClones,
  analyze_hotspots: formatHotspots,
  get_repo_outline: formatRepoOutline,
  suggest_queries: formatSuggestQueries,
  scan_secrets: formatSecrets,
  search_conversations: formatConversations,
  find_conversations_for_symbol: formatConversations,
  search_all_conversations: formatConversations,
  classify_roles: formatRoles,
  assemble_context: formatAssembleContext,
  trace_call_chain: formatCallTree,
  trace_route: formatTraceRoute,
  diff_outline: formatDiffOutline,
  changed_symbols: formatChangedSymbols,
  impact_analysis: formatImpactAnalysis,
  get_knowledge_map: formatKnowledgeMap,
  detect_communities: formatCommunities,
  review_diff: formatReviewDiff,
  find_perf_hotspots: formatPerfHotspots,
  fan_in_fan_out: formatFanInFanOut,
  co_change_analysis: formatCoChange,
  architecture_summary: formatArchitectureSummary,
  analyze_nextjs_components: formatNextjsComponents,
  nextjs_route_map: formatNextjsRouteMap,
  nextjs_metadata_audit: formatNextjsMetadataAudit,
  nextjs_audit_server_actions: formatNextjsAuditServerActions,
  nextjs_api_contract: formatNextjsApiContract,
  nextjs_boundary_analyzer: formatNextjsBoundaryAnalyzer,
  nextjs_data_flow: formatNextjsDataFlow,
  nextjs_middleware_coverage: formatNextjsMiddlewareCoverage,
  framework_audit: formatFrameworkAudit,
  nextjs_link_integrity: formatNextjsLinkIntegrity,
} as const;

export type FormatterToolName = keyof typeof FORMATTER_DISPATCH;

export function dispatchFormatter(toolName: FormatterToolName, data: unknown): string {
  return FORMATTER_DISPATCH[toolName](data as never);
}
