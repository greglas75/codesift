/**
 * Next.js framework audit meta-tool (T11).
 *
 * Dispatches to all 9 sub-tools (component classifier, route map, metadata
 * audit, security audit, API contract, boundary analyzer, link integrity,
 * data flow, middleware coverage), aggregates results into a weighted
 * overall score, and returns a unified `FrameworkAuditResult`.
 */

import { activateGlobalCache, deactivateGlobalCache } from "../utils/nextjs-audit-cache.js";
import { analyzeNextjsComponents } from "./nextjs-component-tools.js";
import { nextjsRouteMap } from "./nextjs-route-tools.js";
import { nextjsMetadataAudit } from "./nextjs-metadata-tools.js";
import { nextjsAuditServerActions } from "./nextjs-security-tools.js";
import { nextjsApiContract } from "./nextjs-api-contract-tools.js";
import { nextjsBoundaryAnalyzer } from "./nextjs-boundary-tools.js";
import { nextjsLinkIntegrity } from "./nextjs-link-tools.js";
import { nextjsDataFlow } from "./nextjs-data-flow-tools.js";
import { nextjsMiddlewareCoverage } from "./nextjs-middleware-coverage-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditDimension =
  | "components"
  | "routes"
  | "metadata"
  | "security"
  | "api_contract"
  | "boundary"
  | "links"
  | "data_flow"
  | "middleware_coverage";

export interface DimensionScore {
  score: number; // 0-100
  weight: number;
  contribution: number;
}

export interface AuditSummary {
  overall_score: number;
  grade: "poor" | "needs_work" | "good" | "excellent";
  dimensions: Partial<Record<AuditDimension, DimensionScore>>;
  top_issues: string[];
}

export interface FrameworkAuditResult {
  summary: AuditSummary;
  sub_results: Partial<Record<AuditDimension, unknown>>;
  tool_errors: Array<{ tool: string; error: string }>;
  cache_size: number;
  duration_ms: number;
}

export interface FrameworkAuditOptions {
  workspace?: string | undefined;
  tools?: AuditDimension[] | undefined;
}

// ---------------------------------------------------------------------------
// Aggregate scoring (Task 47)
// ---------------------------------------------------------------------------

const DIMENSION_WEIGHTS: Record<AuditDimension, number> = {
  metadata: 15,
  security: 25,
  components: 15,
  routes: 10,
  api_contract: 10,
  boundary: 10,
  links: 5,
  data_flow: 5,
  middleware_coverage: 5,
};

function gradeFor(score: number): AuditSummary["grade"] {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 40) return "needs_work";
  return "poor";
}

/** Normalize a sub-tool result to a 0-100 score. */
function normalizeScore(dim: AuditDimension, result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  switch (dim) {
    case "metadata": {
      const counts = r.counts as { excellent: number; good: number; needs_work: number; poor: number } | undefined;
      const total = (r.total_pages as number | undefined) ?? 0;
      if (!counts || total === 0) return 0;
      // Weighted by grade
      return Math.round((counts.excellent * 100 + counts.good * 75 + counts.needs_work * 50 + counts.poor * 0) / total);
    }
    case "security": {
      const actions = r.actions as Array<{ score: number }> | undefined;
      if (!actions || actions.length === 0) return 100; // No actions = no risk
      const avg = actions.reduce((sum, a) => sum + a.score, 0) / actions.length;
      return Math.round(avg);
    }
    case "components": {
      const counts = r.counts as { total: number; unnecessary_use_client: number } | undefined;
      if (!counts || counts.total === 0) return 100;
      // Penalize unnecessary use client
      const penalty = (counts.unnecessary_use_client / counts.total) * 100;
      return Math.max(0, Math.round(100 - penalty));
    }
    case "routes": {
      const conflicts = r.conflicts as unknown[] | undefined;
      const routes = r.routes as unknown[] | undefined;
      if (!routes) return 0;
      // Penalize conflicts
      return conflicts && conflicts.length > 0 ? 70 : 100;
    }
    case "api_contract": {
      return (r.completeness_score as number | undefined) ?? 0;
    }
    case "boundary": {
      // No simple score — use largest_offender presence as a hint
      const entries = r.entries as unknown[] | undefined;
      if (!entries || entries.length === 0) return 100;
      // More client components = lower score
      const count = entries.length;
      return Math.max(0, Math.round(100 - count * 2));
    }
    case "links": {
      const total = r.total_refs as number | undefined;
      const resolved = r.resolved_count as number | undefined;
      const broken = r.broken_count as number | undefined;
      if (!total || total === 0) return 100;
      return Math.round(((resolved ?? 0) / (total - (broken ?? 0) || 1)) * 100);
    }
    case "data_flow": {
      const totalPages = r.total_pages as number | undefined;
      const totalWaterfalls = r.total_waterfalls as number | undefined;
      if (!totalPages || totalPages === 0) return 100;
      const ratio = (totalWaterfalls ?? 0) / totalPages;
      return Math.max(0, Math.round(100 - ratio * 50));
    }
    case "middleware_coverage": {
      const warnings = r.warnings as Array<{ severity: string }> | undefined;
      if (!warnings) return 100;
      const high = warnings.filter((w) => w.severity === "high").length;
      return Math.max(0, 100 - high * 25);
    }
    default:
      return null;
  }
}

export function aggregateScores(
  sub_results: Partial<Record<AuditDimension, unknown>>,
): AuditSummary {
  const dimensions: Partial<Record<AuditDimension, DimensionScore>> = {};
  let totalWeight = 0;
  let weightedSum = 0;
  const top_issues: string[] = [];

  for (const dim of Object.keys(sub_results) as AuditDimension[]) {
    const result = sub_results[dim];
    if (result === undefined) continue;
    const score = normalizeScore(dim, result);
    if (score === null) continue;
    const weight = DIMENSION_WEIGHTS[dim];
    const contribution = (score * weight) / 100;
    dimensions[dim] = { score, weight, contribution };
    totalWeight += weight;
    weightedSum += contribution;
    if (score < 70) {
      top_issues.push(`${dim}: ${score}/100`);
    }
  }

  const overall_score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;

  return {
    overall_score,
    grade: gradeFor(overall_score),
    dimensions,
    top_issues: top_issues.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher (Task 46)
// ---------------------------------------------------------------------------

const ALL_DIMENSIONS: AuditDimension[] = [
  "components",
  "routes",
  "metadata",
  "security",
  "api_contract",
  "boundary",
  "links",
  "data_flow",
  "middleware_coverage",
];

const TOOL_DISPATCHERS: Record<
  AuditDimension,
  (repo: string, workspace?: string) => Promise<unknown>
> = {
  components: (repo, workspace) =>
    analyzeNextjsComponents(repo, workspace ? { workspace } : undefined),
  routes: (repo, workspace) =>
    nextjsRouteMap(repo, workspace ? { workspace } : undefined),
  metadata: (repo, workspace) =>
    nextjsMetadataAudit(repo, workspace ? { workspace } : undefined),
  security: (repo, workspace) =>
    nextjsAuditServerActions(repo, workspace ? { workspace } : undefined),
  api_contract: (repo, workspace) =>
    nextjsApiContract(repo, workspace ? { workspace } : undefined),
  boundary: (repo, workspace) =>
    nextjsBoundaryAnalyzer(repo, workspace ? { workspace } : undefined),
  links: (repo, workspace) =>
    nextjsLinkIntegrity(repo, workspace ? { workspace } : undefined),
  data_flow: (repo, workspace) =>
    nextjsDataFlow(repo, workspace ? { workspace } : undefined),
  middleware_coverage: (repo, workspace) =>
    nextjsMiddlewareCoverage(repo, workspace ? { workspace } : undefined),
};

export async function frameworkAudit(
  repo: string,
  options?: FrameworkAuditOptions,
): Promise<FrameworkAuditResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("framework_audit")) {
    throw new Error("framework_audit is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const start = Date.now();
  const cache = activateGlobalCache();
  const sub_results: Partial<Record<AuditDimension, unknown>> = {};
  const tool_errors: Array<{ tool: string; error: string }> = [];

  const tools = options?.tools ?? ALL_DIMENSIONS;

  try {
    // Sequential invocation — sub-tools share the global cache for parseFile + walkDirectory.
    for (const dim of tools) {
      const dispatcher = TOOL_DISPATCHERS[dim];
      if (!dispatcher) continue;
      try {
        sub_results[dim] = await dispatcher(repo, options?.workspace);
      } catch (err) {
        tool_errors.push({
          tool: dim,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    deactivateGlobalCache();
  }

  const summary = aggregateScores(sub_results);
  const duration_ms = Date.now() - start;

  return {
    summary,
    sub_results,
    tool_errors,
    cache_size: cache.size(),
    duration_ms,
  };
}
