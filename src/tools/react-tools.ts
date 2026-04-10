/**
 * React-specific code intelligence tools.
 *
 * - traceComponentTree: BFS component composition tree (which components
 *   render which, via JSX usage)
 * - analyzeHooks: hook inventory + Rule of Hooks violation detection
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, CallNode } from "../types.js";

export { buildJsxAdjacency, buildComponentTree, extractJsxComponents, extractHookCalls, findRuleOfHooksViolations };

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
