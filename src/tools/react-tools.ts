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

export { buildJsxAdjacency, buildComponentTree, extractJsxComponents, extractHookCalls, extractHookNames, findRuleOfHooksViolations, findRenderRisks, buildReverseAdjacency, computePropChainDepth };
// Tier 7 helpers exported above at definition site (findSuspenseAncestor, findLazyComponentsWithoutSuspense)
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

// ─────────────────────────────────────────────────────────────
// Tier 5 — prop_chain_depth metric helpers
// ─────────────────────────────────────────────────────────────

/**
 * Invert JsxAdjacency to a reverse adjacency: child id → sorted list of parent ids.
 *
 * Used by computePropChainDepth to walk UP the render tree (from a leaf back toward
 * roots) and measure render-tree depth. Sorts each parent list alphabetically for
 * deterministic output on cyclic graphs.
 */
function buildReverseAdjacency(adjacency: JsxAdjacency): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const [parentId, children] of adjacency.children) {
    for (const child of children) {
      const list = parents.get(child.id) ?? [];
      list.push(parentId);
      parents.set(child.id, list);
    }
  }
  // Sort each parent list alphabetically for determinism on cyclic graphs
  for (const [k, v] of parents) parents.set(k, [...v].sort());
  return parents;
}

/**
 * Compute the longest path (in edges) from componentId UP to the deepest root in
 * the reverse JSX adjacency. This is render-tree depth — NOT prop-flow depth.
 *
 * Iterative implementation using an explicit 2-phase ("enter"/"exit") stack to
 * avoid recursive blowup on deep linear chains (V8 stack ~10-15K frames).
 *
 * Uses shared `memo` and `inProgress` across all calls in one analyzeRenders run
 * to amortize cost to O(V+E) total.
 */
function computePropChainDepth(
  componentId: string,
  reverseAdjacency: Map<string, string[]>,
  memo: Map<string, number>,
  inProgress: Set<string>,
): number {
  if (memo.has(componentId)) return memo.get(componentId)!;
  if (inProgress.has(componentId)) return 0;

  type Frame = { node: string; phase: "enter" | "exit" };
  const stack: Frame[] = [{ node: componentId, phase: "enter" }];

  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.phase === "enter") {
      if (memo.has(f.node)) { stack.pop(); continue; }
      if (inProgress.has(f.node)) { stack.pop(); continue; }
      inProgress.add(f.node);
      f.phase = "exit";
      for (const p of reverseAdjacency.get(f.node) ?? []) {
        if (!memo.has(p) && !inProgress.has(p)) {
          stack.push({ node: p, phase: "enter" });
        }
      }
    } else {
      // exit phase — exclude back-edges (parents still in inProgress closing a
      // cycle) so a strongly-connected component with no real root reports
      // depth 0 instead of inflating linearly with cycle-traversal order.
      const parents = reverseAdjacency.get(f.node) ?? [];
      let maxParentDepth = -1;
      let nonCyclicParents = 0;
      for (const p of parents) {
        if (inProgress.has(p)) continue; // back-edge — exclude from depth
        nonCyclicParents++;
        const d = memo.get(p) ?? 0;
        if (d > maxParentDepth) maxParentDepth = d;
      }
      const depth = nonCyclicParents === 0 ? 0 : maxParentDepth + 1;
      memo.set(f.node, depth);
      inProgress.delete(f.node);
      stack.pop();
    }
  }
  return memo.get(componentId)!;
}

// ─────────────────────────────────────────────────────────────
// Tier 7 — Cross-file Suspense ancestor detection
// ─────────────────────────────────────────────────────────────

/**
 * Strip line comments, block comments, and string literals from source before
 * scanning for JSX tokens. Tier 7 R-1 fix — prevents `<Suspense>` mentions in
 * comments/JSDoc/string literals from spoofing the ancestor check.
 *
 * Strategy: replace each construct with whitespace of equal length so line/col
 * positions remain stable for any downstream regex. Order matters:
 *   1. Block comments first (greedy until `* /`)
 *   2. Line comments (until newline)
 *   3. Template literals (handle ${} expressions opaquely — strip whole literal)
 *   4. Single-quoted strings
 *   5. Double-quoted strings
 *
 * This is a heuristic stripper, not a full lexer; it suffices for boundary
 * detection on idiomatic source. Pathological inputs (comment-like text inside
 * unclosed strings) are not the target.
 */
function stripCommentsAndStrings(source: string): string {
  // Single-pass state machine — adversarial review flagged regex layering as
  // unreliable when `//` appears inside string literals (would be consumed as
  // a comment first). State machine processes character-by-character so a
  // `//` inside `"..."` correctly stays inside the string.
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  type State = "code" | "lineComment" | "blockComment" | "single" | "double" | "template" | "regex";
  let state: State = "code";
  // Track previous non-whitespace char to detect when `/` starts a regex literal.
  // After expression-terminating tokens (`)`, `]`, identifier, number, string),
  // `/` means division. After expression-starting context (`=`, `(`, `,`, `;`,
  // `!`, `&`, `|`, `?`, `:`, `{`, `return`, etc.), `/` starts a regex.
  // Heuristic: track last non-space code-state char.
  let lastCodeChar = "";

  function isRegexContext(prev: string): boolean {
    // Conservative: `/` is a regex when preceded by an operator/separator.
    if (prev === "") return true;
    return /[=(,;!&|?:{[<>+\-*%^~]/.test(prev);
  }

  while (i < n) {
    const c = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : "";
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "lineComment"; out.push(" ", " "); i += 2; continue;
      }
      if (c === "/" && next === "*") {
        state = "blockComment"; out.push(" ", " "); i += 2; continue;
      }
      if (c === "/" && isRegexContext(lastCodeChar)) {
        state = "regex"; out.push(" "); i++; continue;
      }
      if (c === "'") { state = "single"; out.push(" "); i++; lastCodeChar = c; continue; }
      if (c === '"') { state = "double"; out.push(" "); i++; lastCodeChar = c; continue; }
      if (c === "`") { state = "template"; out.push(" "); i++; lastCodeChar = c; continue; }
      out.push(c);
      if (!/\s/.test(c)) lastCodeChar = c;
      i++; continue;
    }
    if (state === "lineComment") {
      if (c === "\n") { state = "code"; out.push("\n"); i++; continue; }
      out.push(" "); i++; continue;
    }
    if (state === "blockComment") {
      if (c === "*" && next === "/") {
        state = "code"; out.push(" ", " "); i += 2; continue;
      }
      out.push(c === "\n" ? "\n" : " "); i++; continue;
    }
    if (state === "regex") {
      // Inside /pattern/flags. Closer is unescaped `/`. Char classes [...] disable / closing.
      if (c === "\\" && next) { out.push(" ", " "); i += 2; continue; }
      if (c === "[") {
        // skip char class
        out.push(" "); i++;
        while (i < n && source[i] !== "]") {
          if (source[i] === "\\" && i + 1 < n) { out.push(" ", " "); i += 2; continue; }
          out.push(source[i] === "\n" ? "\n" : " "); i++;
        }
        if (i < n) { out.push(" "); i++; }
        continue;
      }
      if (c === "/") {
        state = "code"; out.push(" "); i++; lastCodeChar = "/"; continue;
      }
      out.push(c === "\n" ? "\n" : " "); i++; continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const closer = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (c === "\\" && next) {
        out.push(" ", " "); i += 2; continue; // skip escaped char
      }
      if (c === closer) {
        state = "code"; out.push(" "); i++; continue;
      }
      out.push(c === "\n" ? "\n" : " "); i++; continue;
    }
  }
  return out.join("");
}

/**
 * Check whether source contains `<Suspense>` or `<React.Suspense>` JSX.
 * Tier 7 R-1 fix: strips comments + string literals first, so JSDoc snippets
 * and string-embedded `<Suspense>` text no longer spoof the check.
 */
function hasSuspenseInSource(source: string): boolean {
  return /<(?:React\.)?Suspense\b/.test(stripCommentsAndStrings(source));
}

/**
 * Walk UP the JSX render tree from a component, looking for any ancestor whose
 * source contains a Suspense boundary. Returns the first ancestor found, or
 * null if no Suspense exists anywhere in the upward chain.
 *
 * Tier 7 — closes the cross-file FP in `react-lazy-no-suspense-same-file` regex
 * (Tier 6 limitation). Reuses `buildReverseAdjacency` infrastructure from Tier 5.
 * Cycle-safe via visited set (BFS on potentially cyclic graph).
 */
export function findSuspenseAncestor(
  componentId: string,
  reverseAdjacency: Map<string, string[]>,
  symbolsById: Map<string, CodeSymbol>,
): { name: string; file: string } | null {
  // Tier 7 fix (gemini Run finding): visited.add() at push-time (not pop-time)
  // prevents O(E) duplicate queue pushes on densely-connected component graphs.
  const visited = new Set<string>([componentId]);
  const queue: string[] = [];
  for (const p of reverseAdjacency.get(componentId) ?? []) {
    if (!visited.has(p)) { visited.add(p); queue.push(p); }
  }

  let head = 0;
  while (head < queue.length) {
    const parentId = queue[head++]!;
    const sym = symbolsById.get(parentId);
    if (sym?.source && hasSuspenseInSource(sym.source)) {
      return { name: sym.name, file: sym.file };
    }
    for (const gp of reverseAdjacency.get(parentId) ?? []) {
      if (!visited.has(gp)) { visited.add(gp); queue.push(gp); }
    }
  }
  return null;
}

/**
 * Find all React.lazy() / lazy() usages whose containing component lacks a
 * Suspense boundary anywhere in its ancestor chain. Cross-file proper detection.
 * Tier 7 — complements the single-file regex `react-lazy-no-suspense-same-file`.
 */
export interface LazyWithoutSuspense {
  name: string;
  file: string;
  start_line: number;
}

export function findLazyComponentsWithoutSuspense(
  symbols: CodeSymbol[],
): LazyWithoutSuspense[] {
  const components = symbols.filter((s) => s.kind === "component");
  const adjacency = buildJsxAdjacency(components);
  const reverseAdj = buildReverseAdjacency(adjacency);
  const symbolsById = new Map<string, CodeSymbol>();
  for (const s of components) symbolsById.set(s.id, s);

  // Tier 7 fix (cursor-agent finding): word-boundary before `lazy` to avoid matching
  // arbitrary `.lazy(` callable chains (e.g., `obj.lazy(`). Match either `React.lazy(`
  // OR bare `lazy(` (named-import form), with `\b` to anchor identifier start.
  const lazyRe = /\b(?:React\.lazy|lazy)\s*\(/;

  // Tier 7 R-4 fix: scan ALL symbols (not just kind="component") for lazy() usage.
  // Module-scope assignments like `const X = lazy(() => import('./X'))` often live
  // outside any component body. For non-component symbols, attribute the issue to
  // the file's nearest component (or to the symbol itself if no component shares
  // the file). Same-file Suspense check still applies — looks at the OWNING
  // component's source for ancestor walking.
  const lazyDeclByFile = new Map<string, LazyWithoutSuspense>();
  for (const sym of symbols) {
    if (!sym.source || !lazyRe.test(stripCommentsAndStrings(sym.source))) continue;
    // Skip if this symbol's source already declares Suspense (same-file safety).
    if (hasSuspenseInSource(sym.source)) continue;
    // Adversarial Run 4 finding: arbitrary `components.find(c.file === sym.file)`
    // could attach to wrong component. Fix: require ALL same-file components to
    // satisfy Suspense rule. Conservative — false-NEGATIVE bias (one wrapped sibling
    // in a multi-component file suppresses warning even if another consumer is unsafe).
    // KNOWN LIMIT (Tier 8): true fix requires graph traversal — find which component
    // actually RENDERS the lazy binding (via JSX `<Heavy/>` reference search), not
    // just file co-location. Tier 8 brainstorm scope.
    const sameFileComponents = components.filter((c) => c.file === sym.file);
    if (sameFileComponents.length === 0) {
      // No component context available — flag the lazy declaration directly.
      const key = sym.file;
      if (!lazyDeclByFile.has(key)) {
        lazyDeclByFile.set(key, { name: sym.name, file: sym.file, start_line: sym.start_line });
      }
      continue;
    }
    const anySafe = sameFileComponents.some((c) => {
      if (hasSuspenseInSource(c.source ?? "")) return true;
      return findSuspenseAncestor(c.id, reverseAdj, symbolsById) !== null;
    });
    if (!anySafe) {
      const key = sym.file;
      if (!lazyDeclByFile.has(key)) {
        lazyDeclByFile.set(key, { name: sym.name, file: sym.file, start_line: sym.start_line });
      }
    }
  }
  return [...lazyDeclByFile.values()];
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
 * Extract unique hook names from source (no line numbers, no cap).
 * Use when you only need the set of hooks — e.g. React context bundle.
 */
function extractHookNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\b(use[A-Z]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    names.add(m[1]!);
  }
  return names;
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
