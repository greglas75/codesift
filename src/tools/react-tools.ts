/**
 * React-specific code intelligence tools.
 *
 * - traceComponentTree: BFS component composition tree (which components
 *   render which, via JSX usage)
 * - analyzeHooks: hook inventory + Rule of Hooks violation detection
 * - analyzeRenders: static re-render risk analysis (inline props, missing memo)
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, CallNode } from "../types.js";

export { buildJsxAdjacency, buildComponentTree, extractJsxComponents, extractHookCalls, findRuleOfHooksViolations, findRenderRisks };

// ── Limits (mirror graph-tools.ts) ──────────────────────────
const MAX_TREE_NODES = 500;
const MAX_CHILDREN_PER_NODE = 20;
const DEFAULT_DEPTH = 3;

// ── React stdlib hooks (used as denylist in tracing and inventory) ──
export const REACT_STDLIB_HOOKS = new Set([
  "useState", "useEffect", "useCallback", "useMemo", "useRef",
  "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
  "useDebugValue", "useDeferredValue", "useTransition", "useId",
  "useSyncExternalStore", "useInsertionEffect", "useOptimistic",
  "useFormState", "useFormStatus", "use",
]);

// ─────────────────────────────────────────────────────────────
// trace_component_tree
// ─────────────────────────────────────────────────────────────

interface JsxAdjacency {
  /** component id → components it renders */
  children: Map<string, CodeSymbol[]>;
}

/**
 * Extract PascalCase JSX element names from source code.
 * Returns the set of component names used via `<ComponentName ...>` or `<ComponentName/>`.
 * HTML elements (lowercase) are skipped.
 */
function extractJsxComponents(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    names.add(m[1]!);
  }
  return names;
}

/**
 * Build component → rendered-components adjacency from the index.
 * Only considers symbols with kind "component" (requires Wave 1 extractor).
 */
function buildJsxAdjacency(symbols: CodeSymbol[]): JsxAdjacency {
  const children = new Map<string, CodeSymbol[]>();

  // name → component symbols lookup (may have multiple definitions with same name)
  const nameToComponents = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    if (sym.kind !== "component") continue;
    const existing = nameToComponents.get(sym.name);
    if (existing) existing.push(sym);
    else nameToComponents.set(sym.name, [sym]);
  }

  for (const sym of symbols) {
    if (sym.kind !== "component" || !sym.source) continue;

    const rendered = extractJsxComponents(sym.source);
    const childList: CodeSymbol[] = [];
    for (const name of rendered) {
      if (name === sym.name) continue; // skip self-reference
      const targets = nameToComponents.get(name);
      if (!targets) continue;
      for (const target of targets) {
        if (target.id !== sym.id) childList.push(target);
      }
    }
    if (childList.length > 0) children.set(sym.id, childList);
  }

  return { children };
}

/**
 * BFS the component composition tree from a root component.
 * Returns a CallNode tree of rendered components up to maxDepth.
 */
function buildComponentTree(
  root: CodeSymbol,
  adjacency: JsxAdjacency,
  maxDepth: number,
): CallNode {
  const visited = new Set<string>([root.id]);
  let totalNodes = 1;

  function expand(symbol: CodeSymbol, depth: number): CallNode {
    if (depth >= maxDepth || totalNodes >= MAX_TREE_NODES) {
      return { symbol, children: [] };
    }
    const kids = adjacency.children.get(symbol.id) ?? [];
    const out: CallNode[] = [];
    for (const kid of kids) {
      if (totalNodes >= MAX_TREE_NODES) break;
      if (out.length >= MAX_CHILDREN_PER_NODE) break;
      if (visited.has(kid.id)) continue;
      visited.add(kid.id);
      totalNodes++;
      out.push(expand(kid, depth + 1));
    }
    return { symbol, children: out };
  }

  return expand(root, 0);
}

function stripSource(sym: CodeSymbol): CodeSymbol {
  const { source: _, repo: _r, tokens: _t, start_col: _sc, end_col: _ec, id, ...rest } = sym;
  const shortId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return { ...rest, id: shortId } as CodeSymbol;
}

function stripTreeSource(node: CallNode): CallNode {
  return {
    symbol: stripSource(node.symbol),
    children: node.children.map(stripTreeSource),
  };
}

function treeToMermaid(tree: CallNode, rootName: string): string {
  const lines: string[] = ["graph TD"];
  const visited = new Set<string>();

  function nodeId(sym: CodeSymbol): string {
    return sym.id.replace(/[^a-zA-Z0-9_]/g, "_");
  }
  function nodeLabel(sym: CodeSymbol): string {
    const shortFile = sym.file.split("/").pop() ?? sym.file;
    return `${sym.name}<br/><small>${shortFile}:${sym.start_line}</small>`;
  }

  function walk(node: CallNode, parentId?: string): void {
    const id = nodeId(node.symbol);
    if (!visited.has(id)) {
      visited.add(id);
      lines.push(`  ${id}["${nodeLabel(node.symbol)}"]`);
    }
    if (parentId) {
      lines.push(`  ${parentId} --> ${id}`);
    }
    for (const child of node.children) {
      walk(child, id);
    }
  }

  walk(tree);
  lines.push(`  %% root: ${rootName}`);
  return lines.join("\n");
}

export interface TraceComponentTreeOptions {
  depth?: number | undefined;
  output_format?: "json" | "mermaid" | undefined;
  include_source?: boolean | undefined;
  include_tests?: boolean | undefined;
}

/**
 * Trace the React component composition tree from a root component.
 * Returns a tree of JSX children (which components the root renders,
 * and recursively their children).
 */
export async function traceComponentTree(
  repo: string,
  rootComponent: string,
  options?: TraceComponentTreeOptions,
): Promise<CallNode | { mermaid: string; root: string; depth: number }> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const maxDepth = options?.depth ?? DEFAULT_DEPTH;
  const outputFormat = options?.output_format ?? "json";
  const includeSource = options?.include_source ?? false;
  const includeTests = options?.include_tests ?? false;

  const symbols = includeTests
    ? index.symbols
    : index.symbols.filter((s) => !isTestFile(s.file));

  // Find root component
  const candidates = symbols.filter(
    (s) => s.name === rootComponent && s.kind === "component",
  );
  const target = candidates[0];
  if (!target) {
    throw new Error(
      `Component "${rootComponent}" not found in repository "${repo}". ` +
      `Make sure it has kind: "component" — index may need refresh.`,
    );
  }

  const adjacency = buildJsxAdjacency(symbols);
  const tree = buildComponentTree(target, adjacency, maxDepth);

  if (outputFormat === "mermaid") {
    return { mermaid: treeToMermaid(tree, rootComponent), root: rootComponent, depth: maxDepth };
  }

  return includeSource ? tree : stripTreeSource(tree);
}

// ─────────────────────────────────────────────────────────────
// analyze_hooks
// ─────────────────────────────────────────────────────────────

export interface HookCall {
  name: string;
  line: number;          // line within the symbol (1-based relative to symbol start)
  is_stdlib: boolean;    // true if in REACT_STDLIB_HOOKS
  context: string;       // the matching line, trimmed
}

export interface HookInventoryEntry {
  name: string;           // component or hook name
  kind: "component" | "hook";
  file: string;
  start_line: number;
  hook_count: number;
  hooks: HookCall[];      // up to 20 hook calls
  violations: string[];   // rule-of-hooks violations found
}

export interface HookUsageSummary {
  name: string;           // hook name (e.g. "useState")
  count: number;
  is_stdlib: boolean;
}

export interface AnalyzeHooksResult {
  entries: HookInventoryEntry[];
  total_components: number;
  total_custom_hooks: number;
  hook_usage: HookUsageSummary[]; // top 20 hooks used across codebase
  violations_count: number;
}

/**
 * Scan a component/hook source for Rule of Hooks violations.
 * Detects: hook inside if/for/while/switch, hook after early return.
 * Returns a list of human-readable violation descriptions.
 */
function findRuleOfHooksViolations(source: string): string[] {
  const violations: string[] = [];

  // Heuristic: hook call inside if/for/while/switch block
  const conditionalHook = /\b(if|for|while|switch)\s*\([^)]*\)\s*\{[^}]*\b(use[A-Z]\w*)\s*\(/;
  const condMatch = conditionalHook.exec(source);
  if (condMatch) {
    violations.push(
      `Hook "${condMatch[2]}" called inside ${condMatch[1]} block — violates Rule of Hooks`,
    );
  }

  // Heuristic: hook after early return
  const earlyReturnHook = /\breturn\s+[^;{]*;\s*\n[\s\S]*?\b(use[A-Z]\w*)\s*\(/;
  const earlyMatch = earlyReturnHook.exec(source);
  if (earlyMatch) {
    violations.push(
      `Hook "${earlyMatch[1]}" called after early return — violates Rule of Hooks`,
    );
  }

  return violations;
}

/**
 * Extract hook calls from source with their relative line number.
 */
function extractHookCalls(source: string): HookCall[] {
  const calls: HookCall[] = [];
  const lines = source.split("\n");
  const pattern = /\b(use[A-Z]\w*)\s*\(/;

  for (let i = 0; i < lines.length && calls.length < 20; i++) {
    const line = lines[i]!;
    const m = pattern.exec(line);
    if (m) {
      calls.push({
        name: m[1]!,
        line: i + 1,
        is_stdlib: REACT_STDLIB_HOOKS.has(m[1]!),
        context: line.trim().slice(0, 160),
      });
    }
  }

  return calls;
}

/**
 * Analyze hook usage across components and custom hooks in a repo.
 *
 * Returns:
 * - per-symbol inventory (hooks called, violations)
 * - codebase-wide hook usage summary
 * - Rule of Hooks violation count
 */
export async function analyzeHooks(
  repo: string,
  options?: {
    component_name?: string | undefined;  // filter to a single component (or omit for all)
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
    max_entries?: number | undefined;
  },
): Promise<AnalyzeHooksResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const componentName = options?.component_name;
  const filePattern = options?.file_pattern;
  const includeTests = options?.include_tests ?? false;
  const maxEntries = options?.max_entries ?? 100;

  // Filter symbols to components and hooks
  let symbols = index.symbols.filter(
    (s) => s.kind === "component" || s.kind === "hook",
  );
  if (!includeTests) symbols = symbols.filter((s) => !isTestFile(s.file));
  if (componentName) symbols = symbols.filter((s) => s.name === componentName);
  if (filePattern) symbols = symbols.filter((s) => s.file.includes(filePattern));

  const entries: HookInventoryEntry[] = [];
  const globalHookCount = new Map<string, number>();
  let totalComponents = 0;
  let totalHooks = 0;
  let violationsCount = 0;

  for (const sym of symbols) {
    if (!sym.source) continue;

    const hookCalls = extractHookCalls(sym.source);
    const violations = findRuleOfHooksViolations(sym.source);

    if (sym.kind === "component") totalComponents++;
    else if (sym.kind === "hook") totalHooks++;

    // Skip empty entries (no hooks, no violations)
    if (hookCalls.length === 0 && violations.length === 0) continue;

    violationsCount += violations.length;

    for (const call of hookCalls) {
      globalHookCount.set(call.name, (globalHookCount.get(call.name) ?? 0) + 1);
    }

    entries.push({
      name: sym.name,
      kind: sym.kind as "component" | "hook",
      file: sym.file,
      start_line: sym.start_line,
      hook_count: hookCalls.length,
      hooks: hookCalls,
      violations,
    });

    if (entries.length >= maxEntries) break;
  }

  // Sort entries: violations first, then by hook_count descending
  entries.sort((a, b) => {
    const vdiff = b.violations.length - a.violations.length;
    if (vdiff !== 0) return vdiff;
    return b.hook_count - a.hook_count;
  });

  const hook_usage: HookUsageSummary[] = [...globalHookCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({
      name,
      count,
      is_stdlib: REACT_STDLIB_HOOKS.has(name),
    }));

  return {
    entries,
    total_components: totalComponents,
    total_custom_hooks: totalHooks,
    hook_usage,
    violations_count: violationsCount,
  };
}

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
  },
): Promise<AnalyzeRendersResult> {
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

  const entries: RenderAnalysisEntry[] = [];
  const summary = { inline_objects: 0, inline_arrays: 0, inline_functions: 0, unstable_defaults: 0, missing_memo: 0 };
  let highRiskCount = 0;

  for (const sym of components) {
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

    // Risk level classification
    const riskLevel: "low" | "medium" | "high" =
      risks.length >= 5 ? "high" :
      risks.length >= 2 ? "medium" : "low";

    if (riskLevel === "high") highRiskCount++;

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

  return {
    entries,
    total_components: components.length,
    high_risk_count: highRiskCount,
    summary,
  };
}
