/**
 * React component tree analysis helpers.
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { resolveAlias } from "../utils/react-alias.js";
import type { CodeSymbol, CallNode } from "../types.js";

// ── Limits (mirror graph-tools.ts) ──────────────────────────
const MAX_TREE_NODES = 500;
const MAX_CHILDREN_PER_NODE = 20;
const DEFAULT_DEPTH = 3;
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

export { buildJsxAdjacency, buildComponentTree, extractJsxComponents, buildReverseAdjacency, computePropChainDepth };
