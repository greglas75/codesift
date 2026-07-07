/**
 * React day-1 onboarding composite.
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";

// ─────────────────────────────────────────────────────────────
// react_quickstart — Day-1 onboarding composite
// ─────────────────────────────────────────────────────────────

export interface ReactQuickstartResult {
  /** Repository overview */
  overview: {
    total_components: number;
    total_custom_hooks: number;
    likely_root_component: string | null;
    stack: {
      state_management: string | null;
      routing: string | null;
      ui_library: string | null;
      form_library: string | null;
      build_tool: string | null;
    };
  };
  /**
   * High-priority pattern hits for onboarding. Entries use `severity: "critical"` for
   * XSS / Rule-of-Hooks / effect-loop issues. For **backward compatibility**, legacy
   * scans that were pre–Tier 5 (`useEffect-missing-cleanup`, `rsc-non-serializable-prop`)
   * remain in this array with `severity: "warning"` — do not assume the field name
   * implies severity. Tier 5 warning-only patterns live in `warnings`; style bucket in `style_issues`.
   */
  critical_issues: Array<{
    pattern: string;
    count: number;
    severity: "critical" | "warning";
  }>;
  /** Tier 5: warning-severity findings (derived-state, stale-closure, context value inline) */
  warnings: Array<{
    pattern: string;
    count: number;
    severity: "warning";
  }>;
  /** Tier 5: style-severity findings (button-no-type, jsx-no-target-blank) */
  style_issues: Array<{
    pattern: string;
    count: number;
    severity: "style";
  }>;
  /** Top 5 most-used hooks across components */
  top_hooks: Array<{ name: string; count: number }>;
  /** Suggested next queries for the agent to run */
  suggested_queries: string[];
}

/**
 * Day-1 onboarding composite for React projects. Single call that runs:
 * - Component/hook inventory
 * - Stack detection (state mgmt, routing, UI lib, form lib, build tool)
 * - Critical pattern scan (XSS, Rule of Hooks, memory leaks)
 * - Top hook usage summary
 * - Suggested follow-up queries
 *
 * Meant to be the first tool a React developer runs on an unfamiliar codebase.
 * Replaces 5-6 manual tool calls with one structured report.
 */
export async function reactQuickstart(
  repo: string,
): Promise<ReactQuickstartResult> {
  const { searchPatterns } = await import("./pattern-tools.js");
  const { analyzeProject } = await import("./project-tools.js");
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  // Inventory
  const components = index.symbols.filter((s) => s.kind === "component" && !isTestFile(s.file));
  const hooks = index.symbols.filter((s) => s.kind === "hook" && !isTestFile(s.file));

  // Find likely root component: prefer App > Root > Main > Layout > Page
  const rootNames = ["App", "Root", "Main", "Layout", "Page"];
  const likelyRoot = components.find((c) => rootNames.includes(c.name))?.name
    ?? components[0]?.name
    ?? null;

  // Stack detection via analyze_project
  let stack: ReactQuickstartResult["overview"]["stack"] = {
    state_management: null,
    routing: null,
    ui_library: null,
    form_library: null,
    build_tool: null,
  };
  try {
    const proj = await analyzeProject(repo, { force: false });
    const rc = (proj as any)?.conventions?.react_conventions;
    const si = (proj as any)?.stack;
    if (rc) {
      stack = {
        state_management: rc.state_management ?? null,
        routing: rc.routing ?? null,
        ui_library: rc.ui_library ?? null,
        form_library: rc.form_library ?? null,
        build_tool: si?.build_tool ?? null,
      };
    } else if (si) {
      stack.build_tool = si.build_tool ?? null;
    }
  } catch {
    // analyze_project may fail on non-React repos — fall through
  }

  // Critical pattern scans — run in parallel.
  // Tier 5: scan list expanded with new patterns, results routed to severity-based buckets.
  const scanList: Array<{ name: string; severity: "critical" | "warning" | "style" }> = [
    { name: "dangerously-set-html", severity: "critical" },
    { name: "hook-in-condition", severity: "critical" },
    { name: "conditional-render-hook", severity: "critical" },
    { name: "useEffect-missing-cleanup", severity: "warning" },
    { name: "useEffect-setstate-loop", severity: "critical" },
    { name: "rsc-non-serializable-prop", severity: "warning" },
    // Tier 5 — warning bucket
    { name: "derived-state", severity: "warning" },
    { name: "stale-closure-setstate", severity: "warning" },
    { name: "context-provider-value-inline", severity: "warning" },
    // Tier 5 — warning (tabnabbing): surfaced in critical_issues with legacy warnings
    { name: "jsx-no-target-blank", severity: "warning" },
    { name: "button-no-type", severity: "style" },
    // Tier 6 — extending Tier 5 coverage
    { name: "derived-state-reducer", severity: "warning" },
    { name: "derived-state-custom-setter", severity: "warning" },
    { name: "stale-closure-toggle", severity: "warning" },
    { name: "stale-closure-broken-functional", severity: "warning" },
    { name: "context-provider-value-via-variable", severity: "warning" },
    { name: "context-provider-value-inline-destructured", severity: "warning" },
    { name: "react-lazy-no-suspense-same-file", severity: "style" },
    { name: "rsc-non-serializable-prop-deep", severity: "critical" },
    { name: "error-boundary-incomplete", severity: "warning" },
  ];
  const scanResults = await Promise.all(
    scanList.map(async ({ name, severity }) => {
      try {
        const result = await searchPatterns(repo, name, { max_results: 20 });
        return { pattern: name, count: result.matches.length, severity };
      } catch {
        return { pattern: name, count: 0, severity };
      }
    }),
  );
  // Severity-aware bucketing — cap each at 10 entries.
  const hits = scanResults.filter((r) => r.count > 0);
  const critical_issues = hits
    .filter((r): r is typeof r & { severity: "critical" | "warning" } => r.severity === "critical")
    .slice(0, 10);
  // Legacy: pre-Tier-5 patterns marked "warning" stay in critical_issues for backward compat;
  // Tier 5 warnings (derived-state, stale-closure, context-provider) go to dedicated bucket.
  const tier5WarningPatterns = new Set([
    // Tier 5
    "derived-state", "stale-closure-setstate", "context-provider-value-inline",
    // Tier 6 — same warning bucket
    "derived-state-reducer", "derived-state-custom-setter",
    "stale-closure-toggle", "stale-closure-broken-functional",
    "context-provider-value-via-variable", "context-provider-value-inline-destructured",
    "error-boundary-incomplete",
  ]);
  for (const r of hits) {
    if (r.severity === "warning" && !tier5WarningPatterns.has(r.pattern) && critical_issues.length < 10) {
      critical_issues.push({ pattern: r.pattern, count: r.count, severity: "warning" });
    }
  }
  const warnings = hits
    .filter((r): r is typeof r & { severity: "warning" } => r.severity === "warning" && tier5WarningPatterns.has(r.pattern))
    .slice(0, 10);
  const style_issues = hits
    .filter((r): r is typeof r & { severity: "style" } => r.severity === "style")
    .slice(0, 10);

  // Top hooks used across components
  const hookCounts = new Map<string, number>();
  for (const c of components) {
    if (!c.source) continue;
    const matches = c.source.matchAll(/\b(use[A-Z]\w*)\s*\(/g);
    for (const m of matches) {
      const name = m[1]!;
      hookCounts.set(name, (hookCounts.get(name) ?? 0) + 1);
    }
  }
  const top_hooks = [...hookCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Suggested next queries
  const suggested_queries: string[] = [];
  if (likelyRoot) {
    suggested_queries.push(`trace_component_tree("${likelyRoot}")  // explore render hierarchy`);
  }
  suggested_queries.push(`analyze_renders()  // find re-render risks`);
  suggested_queries.push(`analyze_hooks()  // Rule of Hooks + hook inventory`);
  if (components.length >= 10) {
    suggested_queries.push(`audit_compiler_readiness()  // React Compiler adoption check`);
  }
  if (critical_issues.some((i) => i.severity === "critical")) {
    suggested_queries.push(`search_patterns("dangerously-set-html")  // investigate XSS risks`);
  }

  return {
    overview: {
      total_components: components.length,
      total_custom_hooks: hooks.length,
      likely_root_component: likelyRoot,
      stack,
    },
    critical_issues,
    warnings,
    style_issues,
    top_hooks,
    suggested_queries,
  };
}
