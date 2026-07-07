/**
 * React static render-risk analysis.
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { buildJsxAdjacency, buildReverseAdjacency, computePropChainDepth } from "./react-component-tree-tools.js";

// ─────────────────────────────────────────────────────────────
// analyze_renders — static re-render risk analysis
// ─────────────────────────────────────────────────────────────

export interface RenderRisk {
  type: "inline-object" | "inline-array" | "inline-function" | "unstable-default" | "missing-memo";
  line: number;        // 1-based within the component source
  context: string;     // trimmed matching line
  suggestion: string;
}

export interface RenderAnalysisEntry {
  name: string;
  file: string;
  start_line: number;
  is_memoized: boolean;       // wrapped in React.memo
  risk_count: number;
  risk_level: "low" | "medium" | "high";
  risks: RenderRisk[];        // up to 20 per component
  /** Components rendered as children (from JSX), useful to see impact */
  children_count: number;
  /**
   * JSX **render-tree** depth: longest path in edges from this component up to a
   * root in the reverse adjacency. Same numeric value as `prop_chain_depth`;
   * this name reflects semantics (not prop-drilling depth). `null` only when
   * `metadata.skipped === "extractor-failure"`.
   */
  jsx_render_depth: number | null;
  /**
   * @deprecated Use `jsx_render_depth`. Same value — retained for backward compatibility.
   * Render-tree depth, not prop-flow depth.
   */
  prop_chain_depth: number | null;
  /** Suggestion text including "NOT prop-drilling depth" disclaimer when depth >= 3 */
  suggestion?: string;
}

export interface AnalyzeRendersResult {
  entries: RenderAnalysisEntry[];
  total_components: number;
  high_risk_count: number;
  summary: {
    inline_objects: number;
    inline_arrays: number;
    inline_functions: number;
    unstable_defaults: number;
    missing_memo: number;
  };
  /** Diagnostic metadata — see `analyzeRenders` implementation for when this is set. */
  metadata?: { skipped?: "extractor-failure" };
}

/** Patterns for inline prop creation in JSX — each creates a new reference every render */
const INLINE_OBJECT_RE = /\b\w+\s*=\s*\{\s*\{/g;       // prop={{ ... }}
const INLINE_ARRAY_RE = /\b\w+\s*=\s*\{\s*\[/g;         // prop={[ ... ]}
const INLINE_FN_RE = /\bon[A-Z]\w*\s*=\s*\{\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/g; // onX={() => ...}

/** Default prop values that create new references: = [] or = {} in params */
const UNSTABLE_DEFAULT_RE = /(?:[:,]\s*)(\w+)\s*=\s*(\[\s*\]|\{\s*\})/g;

/**
 * Analyze a single component source for re-render risks.
 */
function findRenderRisks(source: string): RenderRisk[] {
  const risks: RenderRisk[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length && risks.length < 20; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Inline object prop: prop={{ key: val }}
    if (INLINE_OBJECT_RE.test(line)) {
      INLINE_OBJECT_RE.lastIndex = 0;
      risks.push({
        type: "inline-object",
        line: lineNum,
        context: trimmed.slice(0, 120),
        suggestion: "Extract to a const or useMemo — object literal creates new reference every render",
      });
    }

    // Inline array prop: prop={[1, 2, 3]}
    if (INLINE_ARRAY_RE.test(line)) {
      INLINE_ARRAY_RE.lastIndex = 0;
      risks.push({
        type: "inline-array",
        line: lineNum,
        context: trimmed.slice(0, 120),
        suggestion: "Extract to a const or useMemo — array literal creates new reference every render",
      });
    }

    // Inline function in event handler: onClick={() => ...}
    if (INLINE_FN_RE.test(line)) {
      INLINE_FN_RE.lastIndex = 0;
      risks.push({
        type: "inline-function",
        line: lineNum,
        context: trimmed.slice(0, 120),
        suggestion: "Extract to useCallback or a named handler — arrow function creates new reference every render",
      });
    }

    // Unstable default value: { items = [], config = {} }
    UNSTABLE_DEFAULT_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = UNSTABLE_DEFAULT_RE.exec(line)) !== null && risks.length < 20) {
      risks.push({
        type: "unstable-default",
        line: lineNum,
        context: trimmed.slice(0, 120),
        suggestion: `Default value \`${dm[1]} = ${dm[2]}\` creates new reference every render — hoist to module const`,
      });
    }
  }

  return risks;
}

/**
 * Format an AnalyzeRendersResult as human-readable Markdown.
 * Used by analyzeRenders when format="markdown" is requested.
 */
export function formatRendersMarkdown(result: AnalyzeRendersResult): string {
  const lines: string[] = [];
  lines.push("# Render Analysis");
  lines.push("");
  lines.push(`Total components: ${result.total_components} | High risk: ${result.high_risk_count}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- inline_objects: ${result.summary.inline_objects}`);
  lines.push(`- inline_arrays: ${result.summary.inline_arrays}`);
  lines.push(`- inline_functions: ${result.summary.inline_functions}`);
  lines.push(`- unstable_defaults: ${result.summary.unstable_defaults}`);
  lines.push(`- missing_memo: ${result.summary.missing_memo}`);
  lines.push("");
  lines.push("## Entries");
  lines.push("");
  lines.push("| Component | File | Risk | Issues | Children | Chain | Memo |");
  lines.push("|-----------|------|------|--------|----------|-------|------|");
  for (const e of result.entries) {
    const file = e.file.length > 40 ? "…" + e.file.slice(-39) : e.file;
    const chain =
      e.jsx_render_depth === null ? "—" : String(e.jsx_render_depth);
    lines.push(`| ${e.name} | ${file}:${e.start_line} | ${e.risk_level} | ${e.risk_count} | ${e.children_count} | ${chain} | ${e.is_memoized ? "✓" : "✗"} |`);
  }
  return lines.join("\n");
}

/**
 * Analyze re-render risk across React components in a repo.
 *
 * Detects:
 * - Inline object/array/function props in JSX (new reference every render)
 * - Unstable default parameter values ([] or {} in component params)
 * - Components not wrapped in React.memo that render children (missing-memo)
 *
 * Returns per-component risk assessment with actionable suggestions.
 */
export async function analyzeRenders(
  repo: string,
  options?: {
    component_name?: string | undefined;
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
    max_entries?: number | undefined;
    format?: "json" | "markdown" | undefined;
  },
): Promise<AnalyzeRendersResult | string> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const componentName = options?.component_name;
  const filePattern = options?.file_pattern;
  const includeTests = options?.include_tests ?? false;
  const maxEntries = options?.max_entries ?? 100;

  let components = index.symbols.filter((s) => s.kind === "component");
  if (!includeTests) components = components.filter((s) => !isTestFile(s.file));
  if (componentName) components = components.filter((s) => s.name === componentName);
  if (filePattern) components = components.filter((s) => s.file.includes(filePattern));

  // Tier 5 — extractor-failure: only when we have indexed JSX files but zero
  // component symbols while other symbols exist — likely classification/extractor
  // issues. Pure `.ts`/non-JSX indexes are not flagged (avoids false positives on
  // headless/util libraries).
  const hasJsxIndexedFiles = index.files.some(
    (f) => f.path.endsWith(".tsx") || f.path.endsWith(".jsx"),
  );
  const extractorFailure =
    components.length === 0 &&
    index.symbols.length > 0 &&
    hasJsxIndexedFiles;

  // Tier 5 — sort components alphabetically by id ?? name BEFORE building adjacency
  // for deterministic cycle handling.
  const sortedComponents = [...components].sort((a, b) =>
    (a.id ?? a.name).localeCompare(b.id ?? b.name),
  );
  // Build reverse adjacency once, share memo across all per-component calls (O(V+E) total).
  const adjacency = buildJsxAdjacency(sortedComponents);
  const reverseAdj = buildReverseAdjacency(adjacency);
  const memo = new Map<string, number>();
  const inProgress = new Set<string>();

  const entries: RenderAnalysisEntry[] = [];
  const summary = { inline_objects: 0, inline_arrays: 0, inline_functions: 0, unstable_defaults: 0, missing_memo: 0 };
  let highRiskCount = 0;

  for (const sym of sortedComponents) {
    if (entries.length >= maxEntries) break;
    if (!sym.source) continue;

    const isMemoized = /\b(?:React\.)?memo\s*\(/.test(sym.source);
    const risks = findRenderRisks(sym.source);

    // Count children rendered (PascalCase JSX elements)
    const childrenSet = new Set<string>();
    const jsxPattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
    let jm: RegExpExecArray | null;
    while ((jm = jsxPattern.exec(sym.source)) !== null) {
      if (jm[1] !== sym.name) childrenSet.add(jm[1]!);
    }

    // Check missing-memo: component renders children and is not memoized
    if (!isMemoized && childrenSet.size > 0 && risks.length > 0) {
      risks.push({
        type: "missing-memo",
        line: 1,
        context: `${sym.name} renders ${childrenSet.size} child component(s) and has ${risks.length} inline props`,
        suggestion: "Wrap in React.memo() — parent re-renders will propagate to children via new prop references",
      });
      summary.missing_memo++;
    }

    // Aggregate summary counts
    for (const r of risks) {
      if (r.type === "inline-object") summary.inline_objects++;
      else if (r.type === "inline-array") summary.inline_arrays++;
      else if (r.type === "inline-function") summary.inline_functions++;
      else if (r.type === "unstable-default") summary.unstable_defaults++;
    }

    // Risk level classification — factors children_count to amplify components
    // that propagate prop instability to many children (Bug #4 fix).
    const riskLevel: "low" | "medium" | "high" =
      ((risks.length >= 3 && childrenSet.size >= 3) || risks.length >= 5) ? "high" :
      (risks.length >= 2 || (risks.length >= 1 && childrenSet.size >= 1)) ? "medium" : "low";

    if (riskLevel === "high") highRiskCount++;

    // Tier 5 — render-tree depth (longest acyclic path from this component up to a root).
    // `reverseAdj` is keyed by `sym.id` exclusively (see line 130), so any fallback to
    // sym.name would silently look up a non-existent key. CodeSymbol.id is required by
    // the type contract — dropping the prior `?? sym.name` fallback that masked unset id.
    const depth = computePropChainDepth(sym.id, reverseAdj, memo, inProgress);

    // Tier 5 — suggestion text with explicit "NOT prop-drilling depth" disclaimer
    // when depth >= 3 (AC 8: prevents the metric from being silently relabeled
    // as semantic prop-flow depth, which is Tier 6 scope).
    const suggestion = depth >= 3
      ? `Component is rendered ${depth} edges deep in the JSX render tree. NOT prop-drilling depth — this metric measures render-tree depth only, without tracing which props are consumed vs passed through. Use as a hint to investigate; combine with manual review or trace_component_tree to confirm whether props are actually being drilled. Semantic prop-flow tracking is Tier 6 scope.`
      : undefined;

    // Only include components with risks or if specifically queried
    if (risks.length > 0 || componentName) {
      entries.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        is_memoized: isMemoized,
        risk_count: risks.length,
        risk_level: riskLevel,
        risks,
        children_count: childrenSet.size,
        jsx_render_depth: extractorFailure ? null : depth,
        prop_chain_depth: extractorFailure ? null : depth,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }

  // Sort: high risk first, then by risk_count descending
  entries.sort((a, b) => {
    const levelOrder = { high: 3, medium: 2, low: 1 };
    const ld = levelOrder[b.risk_level] - levelOrder[a.risk_level];
    if (ld !== 0) return ld;
    return b.risk_count - a.risk_count;
  });

  const jsonResult: AnalyzeRendersResult = {
    entries,
    total_components: components.length,
    high_risk_count: highRiskCount,
    summary,
    ...(extractorFailure ? { metadata: { skipped: "extractor-failure" as const } } : {}),
  };

  if (options?.format === "markdown") {
    return formatRendersMarkdown(jsonResult);
  }
  return jsonResult;
}

export { findRenderRisks };
