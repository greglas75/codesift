/**
 * React Suspense and lazy component analysis helpers.
 */
import type { CodeSymbol } from "../types.js";
import { buildJsxAdjacency, buildReverseAdjacency } from "./react-component-tree-tools.js";

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
