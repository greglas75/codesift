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
import { resolveAlias } from "../utils/react-alias.js";
import type { CodeSymbol, CallNode } from "../types.js";

export { buildJsxAdjacency, buildComponentTree, extractJsxComponents, extractHookCalls, findRuleOfHooksViolations, findRenderRisks };
// formatRendersMarkdown and buildContextGraph are exported inline at definition site below

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
  // file → component symbols lookup (used by alias-resolved imports)
  const fileToComponents = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    if (sym.kind !== "component") continue;
    const existing = nameToComponents.get(sym.name);
    if (existing) existing.push(sym);
    else nameToComponents.set(sym.name, [sym]);
    const fileExisting = fileToComponents.get(sym.file);
    if (fileExisting) fileExisting.push(sym);
    else fileToComponents.set(sym.file, [sym]);
  }

  // Build a synthetic files list for resolveAlias() — needs only `path` field.
  const filesList = [...fileToComponents.keys()].map((path) => ({ path }));

  for (const sym of symbols) {
    if (sym.kind !== "component" || !sym.source) continue;

    const rendered = extractJsxComponents(sym.source);
    const childList: CodeSymbol[] = [];

    // Parse alias imports in this component's source for fallback resolution
    // (Tier 4 — Item 8 wired into trace_component_tree).
    // Pattern: import { X, Y as Z } from "@/components/Button"
    // Pattern: import Default from "@/components/Foo"
    const aliasImports = new Map<string, string>(); // localName → resolved file
    const importRe = /import\s+(?:(\w+)|(?:\{([^}]+)\}))(?:\s*,\s*(?:(\w+)|(?:\{([^}]+)\})))?\s+from\s+["'](@\/[^"']+)["']/g;
    let im: RegExpExecArray | null;
    while ((im = importRe.exec(sym.source)) !== null) {
      const aliasPath = im[5]!;
      const resolved = resolveAlias(aliasPath, filesList);
      if (!resolved) continue;
      // default import
      if (im[1]) aliasImports.set(im[1], resolved);
      if (im[3]) aliasImports.set(im[3], resolved);
      // named imports {A, B as C}
      const namedGroup = im[2] ?? im[4];
      if (namedGroup) {
        for (const part of namedGroup.split(",")) {
          const trimmed = part.trim();
          // Handle "X as Y" → local name is Y
          const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
          const localName = asMatch ? asMatch[2]! : trimmed.replace(/\s.*$/, "");
          if (localName) aliasImports.set(localName, resolved);
        }
      }
    }

    for (const name of rendered) {
      if (name === sym.name) continue; // skip self-reference
      const targets = nameToComponents.get(name);
      if (targets) {
        for (const target of targets) {
          if (target.id !== sym.id) childList.push(target);
        }
        continue;
      }
      // Fallback: alias-resolved import lookup
      const aliasTargetFile = aliasImports.get(name);
      if (aliasTargetFile) {
        const fileTargets = fileToComponents.get(aliasTargetFile) ?? [];
        for (const target of fileTargets) {
          if (target.id !== sym.id) childList.push(target);
        }
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
  lines.push("| Component | File | Risk | Issues | Children | Memo |");
  lines.push("|-----------|------|------|--------|----------|------|");
  for (const e of result.entries) {
    const file = e.file.length > 40 ? "…" + e.file.slice(-39) : e.file;
    lines.push(`| ${e.name} | ${file}:${e.start_line} | ${e.risk_level} | ${e.risk_count} | ${e.children_count} | ${e.is_memoized ? "✓" : "✗"} |`);
  }
  return lines.join("\n");
}

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

    // Risk level classification — factors children_count to amplify components
    // that propagate prop instability to many children (Bug #4 fix).
    const riskLevel: "low" | "medium" | "high" =
      ((risks.length >= 3 && childrenSet.size >= 3) || risks.length >= 5) ? "high" :
      (risks.length >= 2 || (risks.length >= 1 && childrenSet.size >= 1)) ? "medium" : "low";

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

  const jsonResult: AnalyzeRendersResult = {
    entries,
    total_components: components.length,
    high_risk_count: highRiskCount,
    summary,
  };

  if (options?.format === "markdown") {
    return formatRendersMarkdown(jsonResult);
  }
  return jsonResult;
}

// ─────────────────────────────────────────────────────────────
// buildContextGraph — React context flow mapping (Item 10)
// ─────────────────────────────────────────────────────────────

export interface ReactContextInfo {
  name: string;
  created_in: { file: string; line: number };
  providers: { file: string; line: number }[];
  consumers: { file: string; component: string; line: number }[];
}

export interface ContextGraph {
  contexts: ReactContextInfo[];
}

const MAX_CONTEXT_SYMBOLS = 500;

/**
 * Build a graph of React Context flows: createContext → Provider → useContext consumers.
 *
 * Single-pass scan over all symbols (capped at 500). No cycle detection — relies
 * on visited set keyed by context name to prevent re-processing.
 *
 * Detection patterns:
 * - createContext call: `const X = createContext(...)` or `const X = React.createContext(...)`
 * - Provider usage: `<X.Provider value={...}>` (anywhere in any source)
 * - Consumer usage: `useContext(X)` (anywhere in any source)
 *
 * Phase 2 features (not implemented here):
 * - Cycle detection in provider chains
 * - Re-render impact analysis ("which consumers re-render when X changes")
 * - Context value type tracking
 */
export function buildContextGraph(symbols: CodeSymbol[]): ContextGraph {
  const contexts = new Map<string, ReactContextInfo>();
  const createPattern = /\bconst\s+(\w+)\s*(?::[^=]+)?\s*=\s*(?:React\.)?createContext\b/g;

  // Pass 1: Find context definitions
  let scanned = 0;
  for (const sym of symbols) {
    if (scanned >= MAX_CONTEXT_SYMBOLS) break;
    if (!sym.source) continue;
    scanned++;
    let m: RegExpExecArray | null;
    createPattern.lastIndex = 0;
    while ((m = createPattern.exec(sym.source)) !== null) {
      const name = m[1]!;
      if (contexts.has(name)) continue;  // visited — skip duplicate definition
      // Compute line offset within symbol source
      const linesBefore = sym.source.slice(0, m.index).split("\n").length;
      contexts.set(name, {
        name,
        created_in: { file: sym.file, line: sym.start_line + linesBefore - 1 },
        providers: [],
        consumers: [],
      });
    }
  }

  if (contexts.size === 0) return { contexts: [] };

  // Pass 2: Find providers and consumers
  scanned = 0;
  for (const sym of symbols) {
    if (scanned >= MAX_CONTEXT_SYMBOLS) break;
    if (!sym.source) continue;
    if (sym.kind !== "component" && sym.kind !== "hook") continue;
    scanned++;
    for (const [ctxName, info] of contexts) {
      // Provider: <X.Provider
      const providerRe = new RegExp(`<${ctxName}\\.Provider\\b`);
      if (providerRe.test(sym.source)) {
        info.providers.push({ file: sym.file, line: sym.start_line });
      }
      // Consumer: useContext(X)
      const consumerRe = new RegExp(`useContext\\s*\\(\\s*${ctxName}\\b`);
      if (consumerRe.test(sym.source)) {
        info.consumers.push({
          file: sym.file,
          component: sym.name,
          line: sym.start_line,
        });
      }
    }
  }

  return { contexts: [...contexts.values()] };
}

// ─────────────────────────────────────────────────────────────
// audit_compiler_readiness — React Compiler adoption readiness
// ─────────────────────────────────────────────────────────────

const COMPILER_PATTERNS = [
  "compiler-side-effect-in-render",
  "compiler-ref-read-in-render",
  "compiler-prop-mutation",
  "compiler-state-mutation",
  "compiler-try-catch-bailout",
  "compiler-redundant-memo",
  "compiler-redundant-usecallback",
] as const;

export interface CompilerReadinessResult {
  /** 0-100 readiness score (100 = fully compatible) */
  readiness_score: number;
  total_components: number;
  /** Components with 0 bailout patterns */
  compatible_components: number;
  /** Components with ≥1 bailout pattern */
  bailout_components: number;
  /** Count of redundant manual memoization (safe to remove post-adoption) */
  redundant_memoization: number;
  /** Bailout issues by pattern, sorted by frequency */
  issues: Array<{ pattern: string; count: number; description: string }>;
  /** Top components with most bailout issues */
  top_bailout_components: Array<{ name: string; file: string; issues: number }>;
}

/**
 * Audit a React codebase for React Compiler (v1.0) adoption readiness.
 *
 * Scans all components for patterns that cause the compiler to silently
 * bail out of auto-memoization. Returns a readiness score (0-100) with
 * prioritized fix list.
 *
 * No competitor offers codebase-wide compiler readiness analysis.
 */
export async function auditCompilerReadiness(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<CompilerReadinessResult> {
  const { searchPatterns } = await import("./pattern-tools.js");
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  // Count total components
  let components = index.symbols.filter((s) => s.kind === "component");
  if (!includeTests) components = components.filter((s) => !isTestFile(s.file));
  if (filePattern) components = components.filter((s) => s.file.includes(filePattern));
  const totalComponents = components.length;

  // Run all compiler patterns in parallel
  const patternResults = await Promise.all(
    COMPILER_PATTERNS.map(async (pattern) => {
      try {
        const result = await searchPatterns(repo, pattern, {
          file_pattern: filePattern,
          include_tests: includeTests,
          max_results: 200,
        });
        return { pattern, matches: result.matches, description: result.pattern };
      } catch {
        return { pattern, matches: [], description: pattern };
      }
    }),
  );

  // Aggregate: which components have bailout issues
  const componentIssues = new Map<string, number>(); // "name@file" → issue count
  let redundantMemoization = 0;
  const issues: CompilerReadinessResult["issues"] = [];

  for (const { pattern, matches, description } of patternResults) {
    if (matches.length === 0) continue;

    const isRedundant = pattern === "compiler-redundant-memo" || pattern === "compiler-redundant-usecallback";
    if (isRedundant) {
      redundantMemoization += matches.length;
    }

    issues.push({
      pattern,
      count: matches.length,
      description: description.split(": ").slice(1).join(": ") || description,
    });

    for (const m of matches) {
      if (!isRedundant) {
        const key = `${m.name}@${m.file}`;
        componentIssues.set(key, (componentIssues.get(key) ?? 0) + 1);
      }
    }
  }

  // Sort issues by count descending
  issues.sort((a, b) => b.count - a.count);

  // Top bailout components
  const top_bailout_components = [...componentIssues.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => {
      const [name, file] = key.split("@");
      return { name: name!, file: file!, issues: count };
    });

  const bailoutCount = componentIssues.size;
  const compatibleCount = Math.max(0, totalComponents - bailoutCount);

  // Readiness score: percentage of components without bailout issues
  const readiness_score = totalComponents > 0
    ? Math.round((compatibleCount / totalComponents) * 100)
    : 100; // empty repo = ready

  return {
    readiness_score,
    total_components: totalComponents,
    compatible_components: compatibleCount,
    bailout_components: bailoutCount,
    redundant_memoization: redundantMemoization,
    issues,
    top_bailout_components,
  };
}

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
  /** Critical pattern violations (XSS, Rule of Hooks, memory leaks) */
  critical_issues: Array<{
    pattern: string;
    count: number;
    severity: "critical" | "warning";
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

  // Critical pattern scans — run in parallel
  const criticalPatterns = [
    { name: "dangerously-set-html", severity: "critical" as const },
    { name: "hook-in-condition", severity: "critical" as const },
    { name: "conditional-render-hook", severity: "critical" as const },
    { name: "useEffect-missing-cleanup", severity: "warning" as const },
    { name: "useEffect-setstate-loop", severity: "critical" as const },
    { name: "rsc-non-serializable-prop", severity: "warning" as const },
  ];
  const scanResults = await Promise.all(
    criticalPatterns.map(async ({ name, severity }) => {
      try {
        const result = await searchPatterns(repo, name, { max_results: 20 });
        return { pattern: name, count: result.matches.length, severity };
      } catch {
        return { pattern: name, count: 0, severity };
      }
    }),
  );
  const critical_issues = scanResults.filter((r) => r.count > 0);

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
    top_hooks,
    suggested_queries,
  };
}
