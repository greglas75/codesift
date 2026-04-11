/**
 * astro_audit — meta-tool that runs all Astro tools in one call.
 *
 * Runs in parallel:
 *   - astro_config_analyze
 *   - astro_analyze_islands
 *   - astro_hydration_audit
 *   - astro_route_map
 *   - astro_actions_audit (if available)
 *   - astro_content_collections (if available)
 *   - astro_migration_check (if available)
 *   - 13 Astro patterns via search_patterns
 *
 * Returns a unified health report with letter score and per-section gates.
 * Mirrors the react_quickstart pattern.
 */

import { getCodeIndex } from "./index-tools.js";
import { analyzeIslandsFromIndex, hydrationAuditFromIndex } from "./astro-islands.js";
import { buildRouteEntries } from "./astro-routes.js";
import { extractAstroConventions } from "./astro-config.js";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GateStatus = "pass" | "warn" | "fail";
export type OverallScore = "A" | "B" | "C" | "D";

export interface AstroAuditResult {
  score: OverallScore;
  gates: {
    config: "pass" | "fail";
    hydration: "pass" | "warn" | "fail";
    routes: "pass" | "warn" | "fail";
    actions: "pass" | "warn" | "fail";
    content: "pass" | "warn" | "fail";
    migration: "pass" | "warn" | "fail";
    patterns: "pass" | "warn" | "fail";
  };
  sections: {
    config?: {
      output_mode: string | null;
      integrations: string[];
      issue_count: number;
    };
    islands?: {
      total_islands: number;
      by_directive: Record<string, number>;
      total_js_budget_kb: number;
    };
    hydration?: {
      score: string;
      total_issues: number;
      errors: number;
      warnings: number;
    };
    routes?: {
      total_routes: number;
      warnings: string[];
    };
    actions?: {
      total_actions: number;
      score: string;
      total_issues: number;
    };
    content?: {
      total_collections: number;
      total_entries: number;
      collections_with_issues: number;
    };
    migration?: {
      current_version: string | null;
      target_version: string;
      total_breaking_changes: number;
      estimated_hours: string;
    };
    patterns?: {
      total_matches: number;
      patterns_fired: string[];
    };
  };
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Astro pattern names (13 patterns from pattern-tools.ts)
// ---------------------------------------------------------------------------

export const ASTRO_PATTERNS = [
  "astro-client-on-astro",
  "astro-glob-usage",
  "astro-set-html-xss",
  "astro-img-element",
  "astro-missing-getStaticPaths",
  "astro-legacy-content-collections",
  "astro-no-image-dimensions",
  "astro-inline-script-no-is-inline",
  "astro-env-secret-in-client",
  "astro-hardcoded-site-url",
  "astro-missing-lang-attr",
  "astro-form-without-action",
  "astro-view-transitions-deprecated",
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

export function deriveOverallScore(gates: AstroAuditResult["gates"]): OverallScore {
  const gateValues = Object.values(gates) as GateStatus[];
  const failCount = gateValues.filter((g) => g === "fail").length;
  const warnCount = gateValues.filter((g) => g === "warn").length;

  if (failCount >= 2) return "D";
  if (failCount === 1) return "C";
  if (warnCount >= 3) return "C";
  if (warnCount >= 1) return "B";
  return "A";
}

function hydrationScoreToGate(score: string, errors: number, warnings: number): GateStatus {
  if (score === "D" || errors >= 1) return "fail";
  if (score === "C" || warnings >= 3) return "warn";
  if (score === "B" || warnings >= 1) return "warn";
  return "pass";
}

// ---------------------------------------------------------------------------
// Pattern result type
// ---------------------------------------------------------------------------

interface PatternCount {
  pattern: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Optional tool loader — gracefully handles missing modules
// ---------------------------------------------------------------------------

/**
 * Attempt to import an optional Astro tool module and call its named export.
 * Returns null if the module doesn't exist (file not yet implemented).
 *
 * We resolve the module path at runtime using createRequire to avoid TypeScript
 * compile-time module resolution for not-yet-implemented tool files.
 */
async function tryImportOptionalTool(
  moduleSuffix: string,
  exportName: string,
  toolArgs: Record<string, unknown>,
): Promise<unknown> {
  // Use createRequire for dynamic resolution so TypeScript doesn't reject the path.
  // The try/catch swallows MODULE_NOT_FOUND for tools not yet implemented.
  try {
    const { createRequire } = await import("node:module");
    const requireFn = createRequire(import.meta.url);
    const resolvedPath = requireFn.resolve(`./${moduleSuffix}.js`);
    const mod = (await import(resolvedPath)) as Record<string, unknown>;
    const fn = mod[exportName];
    if (typeof fn === "function") {
      return await (fn as (args: Record<string, unknown>) => Promise<unknown>)(toolArgs);
    }
  } catch {
    // Module doesn't exist yet or export is missing — skip gracefully
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core logic (works with a CodeIndex directly — testable without getCodeIndex)
// ---------------------------------------------------------------------------

export async function astroAuditFromIndex(
  index: CodeIndex,
  skip: Set<string>,
  patternCounts?: PatternCount[],
): Promise<AstroAuditResult> {
  // Run all tools in parallel
  const [configResult, islandsResult, hydrationResult, routeResult] = await Promise.all([
    // Config
    skip.has("config")
      ? Promise.resolve(null)
      : extractAstroConventions([], index.root).catch(() => null),

    // Islands
    skip.has("islands")
      ? Promise.resolve(null)
      : Promise.resolve(analyzeIslandsFromIndex(index)).catch(() => null),

    // Hydration
    skip.has("hydration")
      ? Promise.resolve(null)
      : Promise.resolve(hydrationAuditFromIndex(index)).catch(() => null),

    // Routes
    skip.has("routes")
      ? Promise.resolve(null)
      : Promise.resolve(buildRouteEntries(index)).catch(() => null),
  ]);

  // Optional tools (astro_actions_audit, astro_content_collections, astro_migration_check)
  // These tool files may not exist yet — attempt dynamic import, fall back gracefully.
  const [actionsResult, contentResult, migrationResult] = await Promise.all([
    skip.has("actions")
      ? Promise.resolve(null)
      : tryImportOptionalTool(
          /* module path resolved at runtime — gracefully skipped if file doesn't exist */
          "./astro-actions",
          "astroActionsAudit",
          { repo: index.repo },
        ),

    skip.has("content")
      ? Promise.resolve(null)
      : tryImportOptionalTool(
          "./astro-content-collections",
          "astroContentCollections",
          { repo: index.repo },
        ),

    skip.has("migration")
      ? Promise.resolve(null)
      : tryImportOptionalTool(
          "./astro-migration",
          "astroMigrationCheck",
          { repo: index.repo },
        ),
  ]);

  // ---------------------------------------------------------------------------
  // Build sections
  // ---------------------------------------------------------------------------

  const sections: AstroAuditResult["sections"] = {};
  const recommendations: string[] = [];

  // Config section
  let configGate: "pass" | "fail" = "pass";
  if (!skip.has("config")) {
    if (!configResult) {
      configGate = "fail";
      recommendations.push("Config analysis failed — ensure astro.config.mjs/ts exists and is parseable.");
    } else {
      sections.config = {
        output_mode: configResult.conventions.output_mode,
        integrations: configResult.conventions.integrations,
        issue_count: configResult.issues.length,
      };
      if (configResult.issues.length > 0) {
        configGate = "fail";
        recommendations.push(`Fix ${configResult.issues.length} config issue(s): ${configResult.issues[0]}`);
      }
    }
  }

  // Islands section
  if (!skip.has("islands") && islandsResult) {
    sections.islands = {
      total_islands: islandsResult.summary.total_islands,
      by_directive: islandsResult.summary.by_directive,
      total_js_budget_kb: islandsResult.summary.budget?.total_js_budget_kb ?? 0,
    };
    if (islandsResult.summary.warnings.length > 0) {
      recommendations.push(`Islands: ${islandsResult.summary.warnings[0]}`);
    }
  }

  // Hydration section
  let hydrationGate: GateStatus = "pass";
  if (!skip.has("hydration")) {
    if (!hydrationResult) {
      hydrationGate = "fail";
    } else {
      const errors = hydrationResult.issues.filter((i) => i.severity === "error").length;
      const warnings = hydrationResult.issues.filter((i) => i.severity === "warning").length;
      sections.hydration = {
        score: hydrationResult.score,
        total_issues: hydrationResult.issues.length,
        errors,
        warnings,
      };
      hydrationGate = hydrationScoreToGate(hydrationResult.score, errors, warnings);
      if (errors > 0) {
        const topError = hydrationResult.issues.find((i) => i.severity === "error");
        if (topError) recommendations.push(`Hydration error (${topError.code}): ${topError.fix}`);
      } else if (warnings >= 3) {
        recommendations.push(`${warnings} hydration warning(s) — review client:load usage`);
      }
    }
  }

  // Routes section
  let routesGate: GateStatus = "pass";
  if (!skip.has("routes")) {
    if (!routeResult) {
      routesGate = "fail";
    } else {
      sections.routes = {
        total_routes: routeResult.routes.length,
        warnings: routeResult.warnings,
      };
      if (routeResult.warnings.length >= 3) {
        routesGate = "fail";
        recommendations.push(`${routeResult.warnings.length} route issue(s): ${routeResult.warnings[0]}`);
      } else if (routeResult.warnings.length > 0) {
        routesGate = "warn";
        recommendations.push(`Route warning: ${routeResult.warnings[0]}`);
      }
    }
  }

  // Actions section — optional tool
  let actionsGate: GateStatus = "pass";
  if (!skip.has("actions") && actionsResult !== null) {
    const ar = actionsResult as {
      total_actions?: number;
      score?: string;
      total_issues?: number;
      issues?: unknown[];
    };
    sections.actions = {
      total_actions: ar.total_actions ?? 0,
      score: ar.score ?? "A",
      total_issues: ar.total_issues ?? (ar.issues ? (ar.issues as unknown[]).length : 0),
    };
    if (sections.actions.score === "D" || sections.actions.score === "C") {
      actionsGate = "fail";
    } else if (sections.actions.score === "B" || sections.actions.total_issues > 0) {
      actionsGate = "warn";
    }
  }

  // Content section — optional tool
  let contentGate: GateStatus = "pass";
  if (!skip.has("content") && contentResult !== null) {
    const cr = contentResult as {
      collections?: unknown[];
      total_collections?: number;
      total_entries?: number;
      collections_with_issues?: number;
      issues?: unknown[];
    };
    const totalCollections = cr.total_collections ?? (cr.collections ? (cr.collections as unknown[]).length : 0);
    const collectionsWithIssues = cr.collections_with_issues ?? 0;
    sections.content = {
      total_collections: totalCollections,
      total_entries: cr.total_entries ?? 0,
      collections_with_issues: collectionsWithIssues,
    };
    if (collectionsWithIssues > 0) {
      contentGate = "warn";
      recommendations.push(`${collectionsWithIssues} content collection(s) have issues`);
    }
  }

  // Migration section — optional tool
  let migrationGate: GateStatus = "pass";
  if (!skip.has("migration") && migrationResult !== null) {
    const mr = migrationResult as {
      current_version?: string | null;
      target_version?: string;
      total_breaking_changes?: number;
      breaking_changes?: unknown[];
      estimated_hours?: string;
    };
    const breakingCount =
      mr.total_breaking_changes ?? (mr.breaking_changes ? (mr.breaking_changes as unknown[]).length : 0);
    sections.migration = {
      current_version: mr.current_version ?? null,
      target_version: mr.target_version ?? "latest",
      total_breaking_changes: breakingCount,
      estimated_hours: mr.estimated_hours ?? "0",
    };
    if (breakingCount > 0) {
      migrationGate = "warn";
      recommendations.push(
        `${breakingCount} breaking change(s) to address for migration to ${sections.migration.target_version}`,
      );
    }
  }

  // Patterns section
  let patternsGate: GateStatus = "pass";
  if (!skip.has("patterns") && patternCounts !== null && patternCounts !== undefined) {
    const fired = patternCounts.filter((r) => r.count > 0);
    const totalMatches = fired.reduce((sum, r) => sum + r.count, 0);
    sections.patterns = {
      total_matches: totalMatches,
      patterns_fired: fired.map((r) => r.pattern),
    };
    if (fired.length >= 3) {
      patternsGate = "fail";
      recommendations.push(
        `${fired.length} anti-pattern(s) detected (${fired[0]!.pattern}, …) — run search_patterns for details`,
      );
    } else if (fired.length > 0) {
      patternsGate = "warn";
      recommendations.push(`Anti-pattern: ${fired[0]!.pattern} (${fired[0]!.count} match(es))`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assemble gates
  // ---------------------------------------------------------------------------

  const gates: AstroAuditResult["gates"] = {
    config: configGate,
    hydration: hydrationGate,
    routes: routesGate,
    actions: actionsGate,
    content: contentGate,
    migration: migrationGate,
    patterns: patternsGate,
  };

  // Trim recommendations to top 5
  const topRecommendations = recommendations.slice(0, 5);

  return {
    score: deriveOverallScore(gates),
    gates,
    sections,
    recommendations: topRecommendations,
  };
}

// ---------------------------------------------------------------------------
// Main meta-tool (MCP entry point)
// ---------------------------------------------------------------------------

export async function astroAudit(args: {
  repo?: string;
  skip?: string[];
}): Promise<AstroAuditResult> {
  const repo = args.repo ?? "";
  const skip = new Set(args.skip ?? []);

  const index = await getCodeIndex(repo);
  if (!index) {
    // Return a minimal failure result when no index is available
    return {
      score: "D",
      gates: {
        config: "fail",
        hydration: "fail",
        routes: "fail",
        actions: "pass",
        content: "pass",
        migration: "pass",
        patterns: "fail",
      },
      sections: {},
      recommendations: ["Run index_folder to index the repository first."],
    };
  }

  // Patterns — run all 13 in parallel, aggregate (requires real repo string)
  let patternCounts: PatternCount[] | undefined;
  if (!skip.has("patterns")) {
    try {
      const { searchPatterns } = await import("./pattern-tools.js");
      patternCounts = await Promise.all(
        ASTRO_PATTERNS.map(async (pat) => {
          try {
            const r = await searchPatterns(repo, pat, { max_results: 20 });
            return { pattern: pat, count: r.matches.length };
          } catch {
            return { pattern: pat, count: 0 };
          }
        }),
      );
    } catch {
      patternCounts = undefined;
    }
  }

  return astroAuditFromIndex(index, skip, patternCounts);
}
