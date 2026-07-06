import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { stripCommentsAndStrings } from "../utils/source-stripper.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

export interface PatternMatch {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  matched_pattern: string;
  context: string;            // the matching line(s)
}

export interface PatternResult {
  matches: PatternMatch[];
  pattern: string;
  scanned_symbols: number;
}

// Built-in patterns inspired by CQ checklist + common React/TS anti-patterns
// Exported for direct regex testing in unit tests.
export const BUILTIN_PATTERNS: Record<string, {
  regex: RegExp;
  description: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  severity?: "critical" | "warning" | "style";
  postFilter?: (match: string) => boolean;
  /**
   * Tier 8 — preprocess source before regex match. "strip-comments-strings"
   * replaces all comment/string/template/regex literal content with whitespace
   * (preserves character positions). Prevents comment- or string-embedded code
   * from spoofing pattern detection. Opt-in per pattern (perf cost: ~O(N) scan).
   */
  preprocess?: "strip-comments-strings";
}> = {
  "useEffect-no-cleanup": {
    regex: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{(?:(?!return\s*\(\s*\)\s*=>|return\s+\(\)\s*=>|return\s*\(\s*\)\s*\{|return\s+function)[\s\S])*\}\s*,/,
    description: "useEffect without cleanup return — potential memory leak (CQ22)",
    severity: "warning",
  },
  // --- React anti-patterns (Wave 2) ---
  "hook-in-condition": {
    regex: /\b(?:if|for|while|switch)\s*\([^)]*\)\s*\{[\s\S]{0,500}?\buse[A-Z]\w*\s*\(/,
    description: "React hook called inside if/for/while/switch — violates Rule of Hooks",
    severity: "critical",
  },
  "useEffect-async": {
    regex: /useEffect\s*\(\s*async\s+(?:function\b|\(|[a-z_$])/,
    description: "async function directly in useEffect — use inner async wrapper (CQ22)",
    severity: "warning",
  },
  "useEffect-object-dep": {
    regex: /useEffect\s*\([\s\S]*?,\s*\[[^\]]*[{[]/,
    description: "Object/array literal in useEffect dependency array — causes infinite re-renders",
    severity: "warning",
  },
  "missing-display-name": {
    regex: /(?:React\.)?(?:memo|forwardRef)\s*\((?:(?!displayName)[\s\S]){0,500}$/,
    description: "React.memo/forwardRef without displayName nearby — harder to debug in DevTools",
    severity: "style",
  },
  "index-as-key": {
    regex: /\.map\s*\(\s*\(\s*\w+\s*,\s*(index|idx|i)\b[^)]*\)\s*=>[\s\S]{0,400}?key\s*=\s*\{?\s*\1\b/,
    description: "Array index used as React key — causes incorrect reconciliation on reorder",
    severity: "warning",
  },
  "inline-handler": {
    regex: /\bon[A-Z]\w*\s*=\s*\{\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/,
    description: "Inline arrow function in JSX event handler — creates new reference every render (memoization killer)",
    severity: "style",
  },
  "conditional-render-hook": {
    regex: /\breturn\s+[^;{]*;\s*\n[\s\S]*?\buse[A-Z]\w*\s*\(/,
    description: "React hook called after early return — violates Rule of Hooks",
    severity: "critical",
  },
  // --- React anti-patterns (Wave 4b — additional) ---
  "dangerously-set-html": {
    regex: /dangerouslySetInnerHTML\s*=\s*\{/,
    description: "dangerouslySetInnerHTML used — XSS risk unless content is sanitized (CQ24). Comment/string-embedded mentions are stripped before matching.",
    severity: "critical",
    preprocess: "strip-comments-strings",
  },
  "direct-dom-access": {
    regex: /\bdocument\.(getElementById|querySelector|querySelectorAll|getElementsBy)\s*\(/,
    description: "Direct DOM access in React component — use useRef instead (breaks SSR, bypasses virtual DOM). Comment/string-embedded mentions stripped before matching.",
    severity: "warning",
    preprocess: "strip-comments-strings",
  },
  "unstable-default-value": {
    regex: /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=\s*(?:\([^)]*\)|[^=]*)\s*=>)\s*[\s\S]{0,100}(?:\{\s*[^}]*=\s*\[\s*\]|\{\s*[^}]*=\s*\{\s*\})/,
    description: "Default prop value [] or {} in component params — creates new reference every render, breaks memo/PureComponent",
    severity: "warning",
  },
  "jsx-falsy-and": {
    regex: /\{\s*(?:count|length|size|num|total|amount)\s*&&\s*</,
    description: "Numeric variable used with && in JSX — renders '0' on screen when falsy. Use ternary or Boolean() (React gotcha)",
    severity: "warning",
  },
  "nested-component-def": {
    regex: /(?:function\s+[A-Z]\w*\s*\([^)]*\)\s*\{|const\s+[A-Z]\w*\s*=\s*(?:\([^)]*\)|[\w$]*)\s*=>\s*\{)[\s\S]{0,1500}?\n\s{2,}(?:function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*\s*=\s*\()/,
    description: "Component defined inside another component — remounts on every parent render, loses all state. Hoist to module level.",
    severity: "critical",
  },
  "usecallback-no-deps": {
    regex: /use(?:Callback|Memo)\s*\([\s\S]*?\)\s*\)\s*[;,]/,
    description: "useCallback/useMemo with only one argument (no dependency array) — useless memoization, value recreated every render",
    severity: "warning",
  },
  // --- React 19 features (Tier 4 — Item 19) ---
  "react19-use-without-suspense": {
    regex: /\buse\s*\(\s*[a-zA-Z_$][\w$]*\s*\)/,
    description: "React 19 use(promise) — must be wrapped in <Suspense> or it throws. Verify Suspense boundary exists in parent.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "critical",
  },
  "react19-server-action-not-async": {
    // Tier 7 fix: matches `export function X`, `export const X = (...) =>`,
    // AND `export default function X` (gemini finding — default exports were missed).
    // 2000-char window for actions defined far from the directive.
    regex: /^[\s\S]{0,200}["']use server["'][\s\S]{0,2000}?\bexport\s+(?:(?:const|let|var)\s+\w+\s*=\s+(?!async\b)(?:\([^)]*\)|\w+)\s*=>|default\s+(?!async\b)function(?:\s+\w+)?\s*\(|(?!async\b)function\s+\w+\s*\()/m,
    description: "React 19 Server Action: function in 'use server' file must be async (returns Promise). Pattern detects `export function X`, `export const X = (...) =>` arrow, AND `export default function X` (default exports).",
    fileIncludePattern: /\.(tsx|jsx|ts|js)$/,
    severity: "critical",
  },
  "react19-form-action-non-function": {
    regex: /<form\s+[^>]*\baction\s*=\s*["'][^"']/,
    description: "React 19 form action prop should be a function (Server Action), not a string URL. Use <form action={serverAction}> for progressive enhancement.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "react19-useoptimistic-no-transition": {
    // Tier 7 fix: \b boundary — myUseTransitionWrapper no longer suppresses match.
    // Tier 8: preprocess strips comment/string content before lookahead — closes
    // Tier 7 R-2.1 known limit (transition tokens in JSDoc/comments).
    regex: /\buseOptimistic\s*\((?![\s\S]{0,1000}?\b(?:useTransition|startTransition)\b)/,
    description: "React 19 useOptimistic should be paired with useTransition/startTransition for non-urgent updates. Comment/string-embedded mentions stripped before matching.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
    preprocess: "strip-comments-strings",
  },
  // --- oxlint-inspired React rules (April 2026) ---
  "hook-usestate-destructure": {
    regex: /(?:^|\n)\s*useState\s*(?:<[^>]+>)?\s*\([^)]*\)\s*;/,
    description: "useState() called without destructuring [value, setter] — value is inaccessible. Use: const [value, setValue] = useState(initial). (oxlint react/hook-use-state)",
    fileIncludePattern: /\.(tsx|jsx|ts)$/,
    severity: "critical",
  },
  "prefer-function-component": {
    regex: /class\s+\w+\s+extends\s+(?:React\.)?(?:Component|PureComponent)\b/,
    description: "Class component could be a function component — class components lack hook support, are harder to tree-shake, and React Compiler cannot optimize them. (oxlint react/prefer-function-component)",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "style",
  },
  // --- React Compiler bailout patterns (GA v1.0, Oct 2025 — Next.js 16 stable) ---
  "compiler-side-effect-in-render": {
    regex: /\b(?:console\.(?:log|warn|error|info)\s*\(|Math\.random\s*\(|Date\.now\s*\(|document\.(?:getElementById|querySelector|createElement)\s*\()/,
    description: "Side effect in render body — React Compiler silently skips memoization. Move to useEffect or event handler.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "compiler-ref-read-in-render": {
    regex: /(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*\w+Ref\.current\b/,
    description: "Reading ref.current during render — React Compiler cannot track ref mutations. Read refs in useEffect or event handlers only.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "compiler-prop-mutation": {
    regex: /\bprops\.\w+\.(?:push|pop|shift|unshift|splice|sort|reverse|fill)\s*\(/,
    description: "Mutating props object — breaks React Compiler immutability assumption. Clone before mutating: [...props.items, newItem].",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "compiler-state-mutation": {
    regex: /(?:^|\n)\s*\w+\.(?:push|pop|shift|unshift|splice|sort|reverse|fill)\s*\([\s\S]{0,200}?set[A-Z]\w*\s*\(\s*\w+\s*\)/,
    description: "Direct state mutation then setState with same reference — React Compiler assumes immutable updates. Use spread: setItems([...items, newItem]).",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "compiler-try-catch-bailout": {
    regex: /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)[\s\S]{0,300}?\btry\s*\{[\s\S]{0,500}?\bcatch\s*\(/,
    description: "try/catch in component body — React Compiler may silently bail out (known issue #35644). Move error handling to useEffect or extract to a hook.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "compiler-redundant-memo": {
    regex: /\b(?:React\.)?memo\s*\(\s*(?:function\s+[A-Z]|(?:\([^)]*\)|[A-Z]\w*)\s*=>)/,
    description: "React.memo wrapping — React Compiler auto-memoizes, making manual memo redundant. Safe to remove after compiler adoption.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "style",
  },
  "compiler-redundant-usecallback": {
    regex: /\buseCallback\s*\(\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/,
    description: "useCallback wrapping — React Compiler auto-memoizes callbacks, making manual useCallback redundant. Safe to remove after compiler adoption.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "style",
  },
  // --- RSC boundary serializability (Tier 4 — Item 18) ---
  "rsc-non-serializable-prop": {
    // Detects patterns like onClick={fn} or callback={handler} on JSX elements
    // when the file has "use client" directive or imports from a client component.
    // Heuristic: prop=function-reference (not arrow inline, that's caught elsewhere).
    regex: /\b(?:onClick|onChange|onSubmit|onError|callback|handler|render)\s*=\s*\{\s*[a-z_$][\w$]*\s*\}/,
    description: "Function passed as prop across RSC boundary — must be a Server Action ('use server') or component must be Client Component ('use client'). Functions are not serializable.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "critical",
  },
  "rsc-date-prop": {
    regex: /\b\w+\s*=\s*\{\s*new\s+Date\s*\(/,
    description: "Date object passed as prop — Date is serializable in JSON but loses prototype across RSC boundary. Use ISO string + parse on client side.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  // --- useEffect pain points (37% of devs struggle — State of React 2025) ---
  "useEffect-missing-cleanup": {
    regex: /useEffect\s*\(\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>[\s\S]{0,800}?(?:addEventListener|setInterval|setTimeout|subscribe|on\s*\()(?:(?!return\s*(?:\(\s*\)\s*=>|function))[\s\S]){0,800}\}\s*,/,
    description: "useEffect with addEventListener/setInterval/subscribe but no cleanup return — memory leak. Return a cleanup function that removes the listener/clears the interval.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  "useEffect-setstate-loop": {
    // Tier 7 fix (multiple gemini findings):
    //  1. Original matched `[` in setState array literal arg → anchored on `}, [`.
    //  2. Cross-effect bridging — non-greedy walk now bails on next `useEffect`.
    //  3. Implicit-return arrows: alternation block-bodied OR concise.
    //  4. `\1\b` matched `count` inside `props.count` — fixed by `(?<!\.)\b\1\b`.
    //  5. Tier 7 review R-3: concise arm's first `\)` could close a NESTED call like
    //     `setCount(getY())`. Fix: require concise-arm setState arg has NO inner `(`
    //     by using `[^()]*` for the simple case (most real bugs); complex args fall
    //     through to the block-bodied arm. Documented as known limit.
    regex: /useEffect\s*\(\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>\s*(?:\{(?:(?!\buseEffect\b)[\s\S]){0,800}?\bset([A-Z]\w*)\s*\((?:(?!\buseEffect\b)[\s\S]){0,300}?\}\s*,\s*\[[^\]]*?(?<!\.)\b\1\b|set([A-Z]\w*)\s*\([^()]{0,200}\)\s*,\s*\[[^\]]*?(?<!\.)\b\2\b)/i,
    description: "setState inside useEffect with same state variable in dependency array — infinite render loop. Block-bodied form `() => { setX(); }, [x]` AND concise form `() => setX(arg), [x]` (concise arm requires non-nested arg). Bails out at next useEffect; rejects `props.count` property chains. Known limit: concise form with nested calls (setX(getY())) is not detected — block form covers it.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "critical",
  },
  "useEffect-missing-deps-identifier": {
    // Heuristic: useEffect with empty dep array [] but body references an
    // identifier that looks like a prop/state (lowerCamelCase, 2+ chars).
    // Subset of eslint-react-hooks/exhaustive-deps — catches the common
    // "empty deps but reads mutable value" bug without full scope analysis.
    regex: /useEffect\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,400}?\b(?:props\.\w+|[a-z][a-zA-Z]*(?:\.\w+)?)[\s\S]{0,400}?\}\s*,\s*\[\s*\]\s*\)/,
    description: "useEffect with empty deps array [] reads props/state identifiers in body — likely missing dependencies. If intentional, add // eslint-disable-next-line react-hooks/exhaustive-deps with reason.",
    fileIncludePattern: /\.(tsx|jsx)$/,
    severity: "warning",
  },
  // --- Next.js 16 cache patterns ---
  "nextjs-use-cache-without-tag": {
    regex: /['"]use cache['"](?:(?!cacheTag\s*\()[\s\S]){0,1000}$/,
    description: "Next.js 16 'use cache' directive without cacheTag() call — cache entry is hard to invalidate. Add cacheTag('name') for targeted revalidation.",
    fileIncludePattern: /\.(tsx|jsx|ts)$/,
    severity: "warning",
  },
  "nextjs-revalidatetag-deprecated": {
    regex: /\brevalidateTag\s*\(\s*['"][^'"]+['"]\s*\)/,
    description: "Next.js 16: revalidateTag() without cacheLife profile (second argument). Single-arg form deprecated — add cacheLife profile.",
    fileIncludePattern: /\.(tsx|jsx|ts)$/,
    severity: "warning",
  },
  // --- TanStack Query patterns ---
  "tanstack-missing-invalidation": {
    regex: /\buseMutation\s*\((?:(?!invalidateQueries|invalidateQuery)[\s\S]){0,800}\}\s*\)/,
    description: "useMutation without invalidateQueries in onSuccess/onSettled — stale data remains in cache after mutation. Add queryClient.invalidateQueries() on success.",
    fileIncludePattern: /\.(tsx|jsx|ts)$/,
    severity: "warning",
  },
  // --- React Tier 5 (May 2026) — derived state, stale closures, context perf, security ---
  "derived-state": {
    regex: /const\s*\[\s*(\w+)\s*,\s*set\1\s*\]\s*=\s*useState\s*\(\s*props\.\1\s*\)[\s\S]{0,2000}?useEffect\s*\([\s\S]{0,500}?set\1\s*\(\s*props\.\1\s*\)/i,
    description: "useState(props.X) + useEffect that syncs setX(props.X) — derived state anti-pattern. Lift state up or compute during render. NOTE: matches when state name follows setX for prop x. Custom-named setters (props.value → setDisplayValue) not detected. The /i flag is intentional — it catches cross-case variants like useState(props.Name) + setName(props.name).",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "stale-closure-setstate": {
    regex: /const\s*\[\s*(\w+)\s*,\s*set([A-Z]\w*)\s*\]\s*=\s*useState[^\n;]*(?:;|\n)(?:(?!const\s*\[\s*\w+\s*,\s*set[A-Z]\w*\s*\]\s*=\s*useState)[\s\S]){0,3000}?\bset\2\s*\(\s*\1\s*[+\-*/]/,
    description: "setState called with non-functional update referencing current state value (setX(X + n)) — risks stale closure in event handlers, timers, or async callbacks. Use functional form: setX(prev => prev + n). NOTE: requires standard [x, setX] = useState() naming; boolean toggles (setOpen(!open)) and broken functional updaters not detected.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "context-provider-value-inline": {
    regex: /<\w+\.Provider\s+[^>]*\bvalue\s*=\s*\{\s*[\{\[]/,
    description: "Context.Provider value is an inline object/array literal — new reference every render forces ALL consumers to re-render. Wrap in useMemo: value={useMemo(() => ({...}), [deps])}. NOTE: does not detect intermediate-variable form or destructured Provider.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "jsx-no-target-blank": {
    regex: /<a\s+(?:(?!>)[\s\S]){0,500}?target\s*=\s*(?:["']_blank["']|\{\s*["']_blank["']\s*\})(?:(?!>)[\s\S]){0,500}?>/,
    description: "<a target=\"_blank\"> without rel=\"noopener noreferrer\" — tabnabbing/window.opener security risk. Add rel=\"noopener noreferrer\". NOTE: matches both string and JSX-brace forms; postFilter requires whitespace before rel= to avoid URL false-positive.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
    // require leading whitespace before `rel` (real attribute, not `?rel=` in URL)
    // AND require rel value to contain BOTH `noopener` AND `noreferrer` as exact
    // whitespace-separated tokens (so `noopenerx noreferrer` does NOT pass).
    // Accepts string form `rel="..."` and JSX-brace-with-string-literal form
    // `rel={"..."}` / `rel={'...'}`. Dynamic JSX expression form `rel={var}`
    // remains a false-positive (cannot be resolved statically).
    postFilter: (match) => {
      const relMatch =
        /\srel\s*=\s*\{\s*["']([^"']*)["']\s*\}/.exec(match)
        ?? /\srel\s*=\s*["']([^"']*)["']/.exec(match);
      if (!relMatch) return true; // no rel attribute → real positive
      const tokens = new Set(relMatch[1]!.toLowerCase().split(/\s+/).filter(Boolean));
      // safe only if both exact tokens present
      return !(tokens.has("noopener") && tokens.has("noreferrer"));
    },
  },
  "button-no-type": {
    regex: /<button(?=[\s>])(?![^>]{0,500}\stype\s*=)[^>]{0,500}>/,
    description: "<button> without explicit type attribute — defaults to type=\"submit\" which can unintentionally submit a form. Add type=\"button\" for non-submit buttons. NOTE: word-boundary lookahead `(?=[\\s>])` ensures HTML <button> only — not <button-group> or <ButtonIcon>. Negative lookahead `(?![^>]{0,500}\\stype\\s*=)` requires whitespace before type= (so data-type= correctly does NOT block the match).",
    severity: "style",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  // --- React Tier 6 (May 2026) — extending Tier 5 coverage ---
  "derived-state-reducer": {
    regex: /useReducer\s*\([\s\S]{0,500}?\)[\s\S]{0,2000}?useEffect\s*\([\s\S]{0,500}?dispatch\s*\(\s*\{\s*type\s*:\s*['"][a-zA-Z_-]*sync/i,
    description: "useReducer + useEffect dispatching a sync-typed action — derived state via reducer.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "derived-state-custom-setter": {
    regex: /useState\s*\(\s*props\.(\w+)\s*\)[\s\S]{0,2000}?useEffect\s*\([\s\S]{0,500}?set[A-Z]\w*\s*\(\s*props\.\1\s*\)/,
    description: "useState(props.X) + useEffect with custom-named setter syncing props.X — derived state anti-pattern (custom setter naming variant).",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "stale-closure-toggle": {
    regex: /const\s*\[\s*(\w+)\s*,\s*set([A-Z]\w*)\s*\]\s*=\s*useState[\s\S]{0,3000}?\bset\2\s*\(\s*!\s*\1\s*\)/,
    description: "setX(!X) boolean toggle — risks stale closure. Use functional form: setX(prev => !prev).",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "stale-closure-broken-functional": {
    // codex Run findings: regex must require updater param NAME ≠ state var name
    // (e.g. `setCount(count => count + 1)` is correct shadowing, not the bug).
    // Three-group form: \1 = state var, \3 = updater param. Match only when \3 != \1
    // by requiring \1 ref AFTER updater param that's a distinct identifier.
    regex: /const\s*\[\s*(\w+)\s*,\s*set([A-Z]\w*)\s*\]\s*=\s*useState[\s\S]{0,3000}?\bset\2\s*\(\s*(?!(?:\1\b))(\w+)\s*=>\s*[\s\S]{0,200}?\b\1\b/,
    description: "Functional updater that references the outer state var instead of the prev parameter (e.g., setCount(prev => count + 1)) — still stale-closure-prone. NOTE: correctly skips intentional shadowing (setCount(count => count + 1)).",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "context-provider-value-via-variable": {
    // gemini findings: original lookbehind was syntactically broken; missed arrays.
    // Fix: drop lookbehind (negation handled via word `useMemo` exclusion in identifier
    // value-source), accept both {object} and [array] literal sources.
    regex: /\b(?:const|let|var)\s+(\w+)\s*=\s*(?!useMemo\b)[{\[][\s\S]{0,500}?[}\]]\s*;[\s\S]{0,500}?<\w+\.Provider\s+[^>]*\bvalue\s*=\s*\{\s*\1\s*\}/,
    description: "Context.Provider value passed via local variable assigned to inline object/array literal — new reference every render. Wrap in useMemo: const ctx = useMemo(() => ({...}), [deps]). Detects both {} and [] forms; correctly skips useMemo-wrapped values.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "context-provider-value-inline-destructured": {
    regex: /const\s*\{\s*([A-Z]\w*Provider\w*|Provider)\s*\}\s*=\s*\w+[\s\S]{0,2000}?<\1\s+[^>]*\bvalue\s*=\s*\{\s*[\{\[]/,
    description: "Destructured Provider with inline object/array literal value — same perf problem as <Ctx.Provider value={{...}}>. Wrap in useMemo.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "react-lazy-no-suspense-same-file": {
    // Tier 6 Item 1 — single-file approximation. Cross-file detection (Suspense in router parent)
    // requires interprocedural analysis — deferred to Tier 7.
    // Codex/gemini findings:
    //  - <React.Suspense> form must be matched (was bypassable with `import * as React`)
    //  - Suspense placed BEFORE lazy() in file was missed (forward-only lookahead)
    // Fix: from-start-of-file negation `((?!<(?:React\.)?Suspense\b)[\s\S])*` + same trailing.
    regex: /^((?!<(?:React\.)?Suspense\b)[\s\S])*(?:const|let|var)\s+[A-Z]\w*\s*=\s*(?:React\.)?lazy\s*\(((?!<(?:React\.)?Suspense\b)[\s\S]){0,3000}?export\s+default/,
    description: "React.lazy() in entrypoint file (has `export default`) without any <Suspense> or <React.Suspense> anywhere in the same file — likely missing Suspense boundary. NOTE: heuristic only — Suspense in router parent file is a known false-positive case (cross-file detection deferred to Tier 7).",
    severity: "style",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "error-boundary-incomplete": {
    // Tier 6 Item 14 — ErrorBoundary coverage (partial). True coverage analysis
    // (which routes wrapped) requires cross-file scope — Tier 7. This pattern detects
    // class components that DEFINE one of the two ErrorBoundary lifecycle methods but
    // not the other, indicating incomplete error handling.
    // Match strategy: class with componentDidCatch but no getDerivedStateFromError in same body
    // (or vice versa) is an incomplete ErrorBoundary.
    regex: /class\s+\w+\s+extends\s+(?:React\.)?(?:Component|PureComponent)\b[\s\S]{0,3000}?(?:componentDidCatch\s*\([\s\S]{0,2000}?\}(?![\s\S]{0,2000}?getDerivedStateFromError)|getDerivedStateFromError\s*\([\s\S]{0,2000}?\}(?![\s\S]{0,2000}?componentDidCatch))/,
    description: "ErrorBoundary class component has componentDidCatch but not getDerivedStateFromError (or vice versa). React requires BOTH lifecycle methods for a complete ErrorBoundary: getDerivedStateFromError to render fallback UI, componentDidCatch to log the error.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "rsc-non-serializable-prop-deep": {
    // Tier 6 Item 11 — deep RSC serializability. Detects common non-serializable types
    // passed across RSC boundary: Map, Set, Class instances (PascalCase constructor),
    // Symbol(). Complements rsc-non-serializable-prop which catches function refs only.
    regex: /\b(?:onClick|onChange|onSubmit|onError|callback|handler|render|data|value|state)\s*=\s*\{\s*new\s+(?:Map|Set|WeakMap|WeakSet|Symbol|RegExp|Promise|[A-Z]\w*)\s*\(/,
    description: "Non-serializable type passed as prop across RSC boundary — Map/Set/Class instance/Symbol/RegExp/Promise are NOT JSON-serializable. Convert to plain object/array on server, reconstruct on client.",
    severity: "critical",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  "empty-catch": {
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    description: "Empty catch block — swallowed error (CQ8). Comment/string-embedded mentions stripped before matching.",
    preprocess: "strip-comments-strings",
  },
  "any-type": {
    regex: /:\s*any\b|as\s+any\b/,
    description: "Usage of 'any' type — lose type safety. Comment/string-embedded mentions stripped before matching.",
    preprocess: "strip-comments-strings",
  },
  "console-log": {
    regex: /console\.(log|debug|info)\s*\(/,
    description: "console.log in production code — use structured logger (CQ13). Comment/string-embedded mentions stripped before matching.",
    preprocess: "strip-comments-strings",
  },
  "await-in-loop": {
    regex: /for\s*\([\s\S]*?\)\s*\{[\s\S]*?await\s/,
    description: "Sequential await inside loop — use Promise.all (CQ17)",
  },
  "no-error-type": {
    regex: /catch\s*\(\s*(\w+)\s*\)\s*\{(?:(?!instanceof\s+Error)[\s\S])*\}/,
    description: "Catch without instanceof Error narrowing (CQ8)",
  },
  "toctou": {
    regex: /findFirst|findUnique[\s\S]{0,200}update\s*\(/,
    description: "Potential TOCTOU: read then write without atomic operation (CQ21)",
  },
  "unbounded-findmany": {
    regex: /findMany\s*\(\s*\{(?:(?!take\b|limit\b)[\s\S])*\}\s*\)/,
    description: "findMany without take/limit — unbounded query (CQ7)",
  },
  "scaffolding": {
    regex: /\/\/\s*(TODO|FIXME|HACK|XXX|TEMP|TEMPORARY)\b|\/\/\s*(Phase|Step|Stage)\s*\d|\/\/\s*(placeholder|stub|dummy)\b|throw new Error\(['"]not implemented['"]\)|console\.(log|warn)\(['"]TODO\b/i,
    description: "Scaffolding markers: TODO/FIXME/HACK, Phase/Step markers, placeholder stubs, not-implemented throws (tech debt)",
  },
  // Kotlin anti-patterns
  "runblocking-in-coroutine": {
    regex: /suspend\s+fun[\s\S]{0,500}runBlocking\s*[\({]/,
    description: "runBlocking inside suspend function — deadlock risk (Kotlin coroutines)",
  },
  "globalscope-launch": {
    regex: /GlobalScope\.(launch|async)\s*[\({]/,
    description: "GlobalScope.launch/async — lifecycle leak, use structured concurrency (Kotlin)",
  },
  "data-class-mutable": {
    regex: /data\s+class\s+\w+\([^)]*\bvar\s+/,
    description: "data class with var property — breaks hashCode/equals contract (Kotlin)",
  },
  "lateinit-no-check": {
    regex: /lateinit\s+var\s+(\w+)/,
    description: "lateinit var without isInitialized check — UninitializedPropertyAccessException risk (Kotlin)",
  },
  "empty-when-branch": {
    regex: /when\s*\([^)]*\)\s*\{[\s\S]*?->\s*\{\s*\}/,
    description: "Empty when branch — swallowed case (Kotlin)",
  },
  "mutable-shared-state": {
    regex: /(?:companion\s+object|object\s+\w+)\s*\{[\s\S]*?\bvar\s+/,
    description: "Mutable var inside object/companion — thread-unsafe shared state (Kotlin)",
  },
  // Kotest anti-patterns — require include_tests=true to surface
  "kotest-missing-assertion": {
    regex: /\btest\s*\(\s*"[^"]*"\s*\)\s*\{(?:(?!\bshould(?:Be|NotBe|Throw|Contain|Match|HaveSize)\b|\bshould\s*\{|\bshouldBe\b|\bassertSoftly\b|\bassertThat\b|\bassertTrue\b|\bassertFalse\b|\bassertEquals\b|\bexpect\s*\(|\bverify\s*\()[\s\S])*?\}/,
    description: "Kotest test block without any shouldBe/shouldThrow/assertSoftly/assertEquals — missing assertion",
  },
  "kotest-mixed-styles": {
    regex: /(?:\bFunSpec\s*\([\s\S]*?(?:\bDescribeSpec|\bStringSpec|\bBehaviorSpec|\bShouldSpec|\bWordSpec|\bFeatureSpec|\bExpectSpec)\s*\()|(?:(?:\bDescribeSpec|\bStringSpec|\bBehaviorSpec|\bShouldSpec|\bWordSpec|\bFeatureSpec|\bExpectSpec)\s*\([\s\S]*?\bFunSpec\s*\()/,
    description: "Multiple Kotest spec styles (e.g. FunSpec + DescribeSpec) in same file — inconsistent test layout",
  },
  // Jetpack Compose anti-patterns
  "compose-missing-remember": {
    regex: /(?<!\bremember\s*\{[^}]{0,60})\b(?:mutableStateOf|mutableStateListOf|mutableIntStateOf|derivedStateOf)\s*(?:<[^>]*>)?\s*\(/,
    description: "mutableStateOf/derivedStateOf without remember — state resets every recomposition (Compose)",
  },
  "compose-unstable-lambda": {
    regex: /@Composable[\s\S]{0,2000}?\bon[A-Z]\w*\s*:\s*\([^)]*\)\s*->\s*Unit/,
    description: "Event callback param with function type — unstable, causes child recomposition every frame unless caller uses remember (Compose)",
  },
  "compose-side-effect-in-composition": {
    regex: /@Composable[\s\S]{0,1000}?(?:\bcoroutineScope\s*\{|\bviewModelScope\.launch|\bGlobalScope\.launch)/,
    description: "Coroutine launch in @Composable body — use LaunchedEffect/rememberCoroutineScope instead (Compose)",
  },
  // PHP anti-patterns
  "sql-injection-php": {
    regex: /\$_(?:GET|POST|REQUEST)\[[^\]]+\][\s\S]{0,200}?(?:->query\(|->execute\(|createCommand\()/,
    description: "User input from $_GET/$_POST flowing into SQL query without sanitization (PHP)",
  },
  "xss-php": {
    regex: /echo\s+\$_(?:GET|POST|REQUEST)\[|print\s+\$_(?:GET|POST|REQUEST)\[/,
    description: "Unescaped user input echoed to output — XSS risk (PHP). Use htmlspecialchars()",
  },
  "eval-php": {
    regex: /\beval\s*\(/,
    description: "eval() usage — code injection risk (PHP)",
  },
  "exec-php": {
    regex: /\b(?:exec|system|passthru|shell_exec|popen|proc_open)\s*\(/,
    description: "Shell command execution — command injection risk (PHP)",
  },
  "unserialize-php": {
    regex: /\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/,
    description: "unserialize() on user input — deserialization attack risk (PHP)",
  },
  "file-include-var": {
    regex: /(?:require|include)(?:_once)?\s*\(?\s*\$(?!this)/,
    description: "require/include with variable — file inclusion risk (PHP)",
  },
  "unescaped-yii-view": {
    regex: /<\?=\s*\$(?!this->(?:render|beginBlock|endBlock))(?!.*?Html::encode)/,
    description: "Yii2 view outputs variable without Html::encode() — XSS risk",
  },
  "raw-query-yii": {
    regex: /createCommand\s*\(\s*["'][^"']*\$\{?\w+/,
    description: "Yii2 createCommand with string interpolation — SQL injection risk",
  },
  // --- Yii2 / PHP additional security & quality patterns (Sprint 2) ---
  "yii-csrf-disabled": {
    // Property assignment OR rule override that disables CSRF on a controller.
    // Common false positive: test-only configs intentionally disable CSRF.
    // We exclude config/test*.php at the search-pattern level via fileIncludePattern.
    regex: /\benableCsrfValidation\s*=\s*false\b/,
    description:
      "CSRF validation explicitly disabled on a controller — accepts forged requests for state-changing actions (Yii2)",
    fileIncludePattern: /\.php$/,
  },
  "yii-debug-mode-prod": {
    // Hard-coded `define('YII_DEBUG', true)` in web/index.php is a deploy
    // disaster — full stack traces leak into production HTTP responses.
    // The pattern intentionally matches both `define()` and `defined() and`
    // forms, since both are legal Yii2 entry-point styles.
    regex:
      /\b(?:define|defined)\s*\(\s*['"]YII_DEBUG['"][^)]*(?:,\s*true|\)\s*(?:and|&&)\s*YII_DEBUG\s*===?\s*true)/,
    description:
      "YII_DEBUG enabled — leaks full stack traces, file paths, and variable contents in HTTP responses (Yii2)",
  },
  "yii-cookie-no-validation": {
    // Empty / placeholder cookie validation key disables HMAC integrity on
    // signed cookies. Matches blank string or obvious placeholder values.
    regex:
      /['"]cookieValidationKey['"]\s*=>\s*['"](?:|change[-_]?me|TODO|xxx+|FIXME|placeholder|insert[-_]?key)['"]/i,
    description:
      "cookieValidationKey is empty or placeholder — signed cookies have no HMAC integrity check (Yii2)",
  },
  "yii-mass-assignment-unsafe": {
    // ->setAttributes($_POST) / ->setAttributes($request->post()) — usually
    // unsafe unless paired with safeAttributes()/scenarios(). We can't tell
    // statically that the class has scenarios(); flag as MEDIUM and let the
    // reviewer make the call.
    regex:
      /->setAttributes\s*\(\s*(?:\$_(?:POST|GET|REQUEST)\b|Yii::\$app->request->(?:post|get)\(\s*\))/,
    description:
      "setAttributes() called with raw user input — bypasses scenarios() guards if not paired with safeAttributes (Yii2)",
  },
  "yii-raw-sql-where": {
    // ActiveQuery->where("col = $var") — string interpolation in WHERE.
    // Matches both single and double quotes. Yii2 supports param-binding
    // via array form `['=', 'col', $var]` which is the safe alternative.
    regex: /->where\s*\(\s*["'][^"']*\$\{?[a-zA-Z_]/,
    description:
      "ActiveQuery->where() with string concatenation — bypasses Yii2 parameter binding (Yii2 SQL injection risk)",
  },
  "php-md5-password": {
    // md5/sha1 applied to anything that smells like a password/secret.
    // High false-positive risk on legitimate hash use; severity HIGH because
    // when it IS a password hash it's a CVE-class bug.
    regex:
      /\b(?:md5|sha1)\s*\(\s*\$(?:password|hasl|haslo|pwd|pass|secret|token|hash)\b/i,
    description:
      "md5() or sha1() used on password/secret — both are broken for password hashing. Use password_hash() / Yii::\\$app->security->generatePasswordHash() (PHP)",
  },
  "php-rand-token": {
    // rand() / mt_rand() / uniqid() on a variable named like a token/secret.
    regex:
      /\$(?:token|nonce|csrf|secret|api[_-]?key|reset[_-]?key)\s*=\s*(?:rand|mt_rand|uniqid)\s*\(/i,
    description:
      "rand()/mt_rand()/uniqid() used to generate token/secret — not cryptographically secure. Use random_bytes() / Yii::\\$app->security->generateRandomString() (PHP)",
  },
  "php-loose-comparison-secret": {
    // == on hash/token comparison — timing attack. Very narrow regex;
    // requires explicit variable naming.
    regex:
      /\b(?:==|!=)\s*\$(?:hash|token|signature|hmac|expected[_-]?hash|secret)\b|\$(?:hash|token|signature|hmac)\s*(?:==|!=)\s*[\$"']/i,
    description:
      "Loose comparison on secret/hash/token — timing-attack vulnerable. Use hash_equals() (PHP)",
  },
  "yii-rbac-cached-permission": {
    // ->can() inside a foreach loop — DbManager hits the DB per call site,
    // O(n) DB roundtrips on a list view. Match foreach + ->can within a
    // bounded window so we don't false-flag unrelated calls in long files.
    regex: /\bforeach\s*\([^{]*\{[\s\S]{0,800}?->can\s*\(/,
    description:
      "->can() called inside foreach — Yii2 DbManager hits the DB per call. Cache permissions or use checkAccess() once outside the loop (Yii2)",
  },
  "yii-no-row-level-locking": {
    // beginTransaction in the same function as findOne/find()->one()
    // without ->forUpdate() — concurrency bug in incentive/payment flows.
    // Bounded window prevents false positives on long methods that legitimately
    // separate the transaction from the read.
    regex:
      /->beginTransaction\s*\(\s*\)[\s\S]{0,1500}?(?:::findOne\s*\(|->one\s*\(\s*\))(?![\s\S]{0,200}->forUpdate\b)/,
    description:
      "Transaction reads a row without SELECT FOR UPDATE — concurrent writers can race and produce duplicate state mutations (Yii2)",
  },
  "yii-config-hardcoded-secret": {
    // Hardcoded literal in 'cookieValidationKey' / 'apiKey' / 'jwtSecret'.
    // Hex/base64 strings of >=20 chars are strong signal. We allow common
    // env() / getenv() lookups as escape hatch.
    regex:
      /['"](?:cookieValidationKey|apiKey|jwtSecret|secretKey|app[_-]?secret|stripe[_-]?secret)['"]\s*=>\s*['"][A-Za-z0-9+\/_=-]{20,}['"]/,
    description:
      "Hardcoded secret in config array — should come from env var or runtime/config-local.php that is gitignored (Yii2)",
  },
  "yii-unbounded-all": {
    // Find()-builder ending in ->all() inside a console controller. We can't
    // easily restrict via path in regex, so use file include pattern. The
    // pattern matches any `find()...all()` chain that doesn't use ->limit().
    regex: /::find\s*\([^)]*\)[\s\S]{0,400}?->all\s*\(\s*\)(?![\s\S]{0,100}->limit\b)/,
    description:
      "ActiveQuery->all() without ->limit() — loads the entire result set into memory. Use ->batch()/->each() for cron/console flows (Yii2 perf)",
    fileIncludePattern: /(?:commands|console)\/[^/]+Controller\.php$/,
  },
  // --- Sprint 7 perf patterns (sourced from tgm-panel performance-audit findings) ---
  "yii-translate-in-loop": {
    // Yii::t() inside a foreach. Costly when paired with DbMessageSource and
    // no message cache (which IS the tgm-panel perf-audit P1 finding). 800-char
    // window after the foreach captures typical loop bodies; nested loops
    // matched separately by global /g.
    regex: /\bforeach\s*\([^{]*\{[\s\S]{0,800}?\\?\bYii::t\s*\(/,
    description:
      "Yii::t() inside foreach — expensive when DbMessageSource caching is off. Move translation outside the loop OR enable enableCaching on the message source (Yii2 perf)",
  },
  "yii-dbtarget-info-level": {
    // DbTarget log target with 'levels' including info/trace/profile.
    // Writes setting often left from local dev; writes to DB on every
    // request hits hard at scale. Bounded window captures the array.
    regex:
      /['"]class['"]\s*=>\s*['"][^'"]*DbTarget['"][\s\S]{0,400}?['"]levels['"]\s*=>\s*\[[^\]]*\b(?:info|trace|profile)\b/,
    description:
      "DbTarget logging info/trace/profile to DB on every request — moves the logger off the hot path (Yii2 perf)",
  },
  "yii-find-with-large-then-filter": {
    // ->find()->all() followed by `array_filter` / `array_map` on the result —
    // pull-then-filter pattern that should be ->where()->all() instead.
    regex: /->find\s*\([^)]*\)[\s\S]{0,200}?->all\s*\(\s*\)\s*;\s*[^\n]{0,200}?\barray_(?:filter|map)\s*\(/,
    description:
      "ActiveQuery->all() into array_filter/array_map — push the filter into the WHERE clause to reduce I/O (Yii2 perf)",
  },
  "yii-cache-no-ttl": {
    // Yii::$app->cache->set('key', $value)  — no TTL argument means cache
    // entry persists indefinitely. Often the deliberate choice, but on
    // user-keyed caches it's a memory bomb.
    regex: /\\?\bYii::\$app->cache->set\s*\(\s*[^,]+,\s*[^,)]+\)/,
    description:
      "cache->set without TTL — entry persists indefinitely. Add a third TTL argument unless caching a global config value (Yii2 perf)",
  },
  "yii-no-batch-on-large": {
    // Same as yii-unbounded-all but applies to non-controller files (services,
    // jobs/, components/). Together they cover 95% of unbounded reads.
    regex: /::find\s*\([^)]*\)[\s\S]{0,400}?->all\s*\(\s*\)(?![\s\S]{0,100}->(?:limit|batch|each)\b)/,
    description:
      "find()->all() in service/job code without ->limit() / ->batch() / ->each() — risk of OOM on growing tables (Yii2 perf)",
    fileIncludePattern: /(?:components|services|jobs|workers|tasks)\/[^/]+\.php$/,
  },
  // NestJS anti-patterns
  "nest-circular-inject": {
    regex: /@Inject\s*\(\s*forwardRef\s*\(/,
    description: "Circular dependency via forwardRef — restructure module boundaries (NestJS)",
  },
  "nest-catch-all-filter": {
    regex: /@Catch\s*\(\s*\)/,
    description: "@Catch() with no argument — catches all exceptions indiscriminately (NestJS)",
  },
  "nest-request-scope": {
    regex: /scope:\s*Scope\.REQUEST/,
    description: "Request-scoped provider — performance overhead, breaks singleton assumptions (NestJS)",
  },
  "nest-raw-exception": {
    regex: /throw\s+new\s+Error\s*\(/,
    description: "Raw Error thrown instead of NestJS HttpException/BadRequestException (NestJS)",
  },
  "nest-any-guard-return": {
    regex: /canActivate[\s\S]{0,100}return\s+true\s*;/,
    description: "Guard always returns true — security no-op (NestJS)",
  },
  "nest-service-locator": {
    regex: /moduleRef\s*\.\s*(?:get|resolve)\s*\(/,
    description: "Service locator via ModuleRef.get/resolve — use constructor injection instead (NestJS)",
  },
  "nest-direct-env": {
    regex: /process\.env\.\w+/,
    description: "Direct process.env access — use ConfigService for type-safe config (NestJS)",
  },
  // Wave 2 anti-patterns
  "nest-graphql-no-auth": {
    // R-7 fix: restrict to .resolver.ts files (via fileIncludePattern) to avoid
    // false positives on REST @Query() params. Regex checks for @Resolver + @Query/@Mutation
    // present AND no @UseGuards anywhere in the matched span (capped at 2000 chars to avoid
    // catastrophic backtracking — O(n) since the negation only runs once per symbol source).
    regex: /^(?![\s\S]*@UseGuards)[\s\S]*@Resolver\s*\([\s\S]{0,500}?@(?:Query|Mutation)\s*\(/,
    description: "GraphQL resolver with @Query/@Mutation but no @UseGuards in file — likely unprotected (NestJS)",
    fileIncludePattern: /\.resolver\.[jt]sx?$/,
  },
  "nest-eager-relation": {
    regex: /@(?:OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*\w+[\s\S]{0,200}\beager:\s*true/,
    description: "TypeORM relation with { eager: true } — auto-loads joins on every query (NestJS)",
  },
  // Wave 3: nestjs-doctor rule parity batch (15 rules)
  // --- Security (5 rules) ---
  "nest-typeorm-synchronize-prod": {
    regex: /synchronize:\s*true(?![\s\S]{0,100}NODE_ENV\s*!==\s*['"`]production)/,
    description: "TypeORM synchronize: true — schema auto-sync in production drops/recreates tables (NestJS)",
    fileIncludePattern: /\.(ts|js)$/,
  },
  "nest-exposed-stack-trace": {
    regex: /\.stack\s*(?:,|\)|\}|\n)/,
    description: "Error.stack exposed in response/log — leaks internal paths and line numbers (NestJS security)",
    fileIncludePattern: /\.(controller|filter|interceptor)\.[jt]sx?$/,
  },
  "nest-raw-entity-response": {
    regex: /return\s+(?:await\s+)?this\.\w+Repository\.find/,
    description: "Raw entity returned from controller — bypasses @Exclude/@Transform, leaks internal fields (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-cors-wildcard": {
    regex: /(?:cors:\s*(?:true|\{\s*origin:\s*['"`]\*['"`])|enableCors\s*\(\s*\{\s*origin:\s*['"`]\*['"`])/,
    description: "CORS wildcard origin — allows any site to make credentialed requests (NestJS security)",
  },
  "nest-disabled-csrf": {
    regex: /csrf:\s*false|csrfProtection.*disabled/i,
    description: "CSRF protection disabled — forms vulnerable to cross-site request forgery (NestJS)",
  },
  // --- Correctness (5 rules) ---
  "nest-missing-guard-method": {
    regex: /implements\s+(?:Can(?:Activate|Load)|NestGuard)(?:\s*\{(?![\s\S]{0,500}(?:canActivate|canLoad)\s*\())/,
    description: "Guard class implements CanActivate/CanLoad but missing the required method (NestJS)",
    fileIncludePattern: /\.guard\.[jt]sx?$/,
  },
  "nest-missing-pipe-transform": {
    regex: /implements\s+PipeTransform(?:\s*\{(?![\s\S]{0,500}transform\s*\())/,
    description: "Pipe class implements PipeTransform but missing transform() method (NestJS)",
    fileIncludePattern: /\.pipe\.[jt]sx?$/,
  },
  "nest-missing-filter-catch": {
    regex: /implements\s+ExceptionFilter(?:\s*\{(?![\s\S]{0,500}catch\s*\())/,
    description: "Exception filter class implements ExceptionFilter but missing catch() method (NestJS)",
    fileIncludePattern: /\.filter\.[jt]sx?$/,
  },
  "nest-missing-interceptor-intercept": {
    regex: /implements\s+NestInterceptor(?:\s*\{(?![\s\S]{0,500}intercept\s*\())/,
    description: "Interceptor class implements NestInterceptor but missing intercept() method (NestJS)",
    fileIncludePattern: /\.interceptor\.[jt]sx?$/,
  },
  "nest-param-decorator-no-type": {
    regex: /@Param\s*\(\s*['"`]\w+['"`]\s*\)\s*\w+\s*[,)]/,
    description: "@Param('id') parameter without type annotation — `id` inferred as `any` (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  // --- Architecture (3 rules) ---
  "nest-orm-in-controller": {
    regex: /(?:@InjectRepository|this\.\w+Repository\.(?:find|save|update|delete|remove))/,
    description: "Direct ORM/Repository usage in controller — violates separation of concerns (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-business-logic-in-controller": {
    regex: /\bif\s*\(\s*\w+\s*\.\s*\w+\s*(?:===|!==|>|<|>=|<=)[\s\S]{0,200}(?:throw\s+new|await\s+this\.)/,
    description: "Complex branching + async call in controller — business logic belongs in a service (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-moduleref-get": {
    regex: /\bmoduleRef\s*\.\s*(?:get|resolve)\s*\(\s*['"`]?\w+/,
    description: "Service locator via ModuleRef.get/resolve — use constructor injection instead (NestJS)",
  },
  // --- Performance (2 rules) ---
  "nest-sync-fs-in-handler": {
    regex: /\b(?:readFileSync|writeFileSync|existsSync|statSync|mkdirSync)\s*\(/,
    description: "Synchronous filesystem call blocks the event loop — use fs/promises (NestJS)",
    fileIncludePattern: /\.(controller|service)\.[jt]sx?$/,
  },
  "nest-require-primary-key": {
    regex: /@Entity\s*\([\s\S]{0,200}(?:export\s+)?class\s+\w+(?:\s+extends\s+\w+)?\s*\{(?![\s\S]{0,500}@Primary(?:Generated)?Column)/,
    description: "@Entity without @PrimaryColumn/@PrimaryGeneratedColumn — TypeORM will fail at runtime (NestJS)",
    fileIncludePattern: /\.entity\.[jt]sx?$/,
  },
  // Astro anti-patterns
  "astro-client-on-astro": {
    regex: /client:(load|idle|visible|media|only).*\.astro/,
    description: "client directive on .astro component import (Astro components cannot hydrate)",
  },
  "astro-glob-usage": {
    regex: /Astro\.glob\s*\(/,
    description: "Astro.glob() REMOVED in Astro 6 — use getCollection() or import.meta.glob() (BREAKING)",
  },
  "astro-set-html-xss": {
    regex: /set:html=\{[^"'][^}]*\}/,
    description: "set:html with dynamic content — potential XSS risk",
  },
  "astro-img-element": {
    regex: /<img\s/,
    description: "raw <img> element — use <Image> from astro:assets for optimization",
  },
  "astro-missing-getStaticPaths": {
    regex: /\[[\w.]+\]\.astro/,
    description: "dynamic route file — verify getStaticPaths is exported",
  },
  "astro-legacy-content-collections": {
    regex: /src\/content\/config\.ts/,
    description: "Legacy content collections REMOVED in Astro 6 — migrate to src/content.config.ts + Content Layer API (BREAKING)",
  },
  "astro-no-image-dimensions": {
    regex: /<Image\s+(?![^>]*(?:width|height)\s*=)[^>]*\/?>/,
    description: "<Image> without width/height — causes CLS (Cumulative Layout Shift)",
  },
  "astro-inline-script-no-is-inline": {
    regex: /<script(?!\s+is:inline)(?:\s[^>]*)?>[\s\S]*?<\/script>/,
    description: "<script> without is:inline — Astro will process/bundle it; add is:inline for raw passthrough",
  },
  "astro-env-secret-in-client": {
    regex: /import\.meta\.env\.SECRET_/,
    description: "import.meta.env.SECRET_* accessed — secret env vars are server-only, undefined in client components",
  },
  "astro-hardcoded-site-url": {
    regex: /(?:href|src|url)\s*=\s*["']https?:\/\/(?!\/\/)[^"']*["']/,
    description: "hardcoded absolute URL — use Astro.site or relative paths for portability",
  },
  "astro-missing-lang-attr": {
    regex: /<html(?!\s[^>]*\blang\s*=)[^>]*>/,
    description: "<html> without lang attribute — required for accessibility (WCAG 3.1.1)",
  },
  "astro-form-without-action": {
    regex: /<form(?!\s[^>]*\baction\s*=)[^>]*>/,
    description: "<form> without action attribute — consider Astro Actions for type-safe form handling",
  },
  "astro-view-transitions-deprecated": {
    regex: /<ViewTransitions\s*\/?>/,
    description: "<ViewTransitions /> renamed to <ClientRouter /> in Astro 6 (BREAKING) — update import from astro:transitions",
  },
  // Next.js anti-patterns
  "nextjs-wrong-router": {
    regex: /from\s+['"]next\/router['"]|require\s*\(\s*['"]next\/router['"]\s*\)/,
    description: "Using next/router (Pages Router) in App Router file — use next/navigation instead",
    fileExcludePattern: /(^|\/)pages\//,
  },
  "nextjs-fetch-waterfall": {
    regex: /await\s+fetch\s*\([^)]*\)[\s\S]{0,300}await\s+fetch\s*\(/,
    description: "Sequential await fetch calls — use Promise.all to avoid waterfall (Next.js performance)",
  },
  "nextjs-unnecessary-use-client": {
    regex: /['"]use client['"](?![\s\S]*(?:useState|useEffect|useRef|useCallback|useMemo|useContext|useReducer|onClick|onChange|onSubmit|window\.|document\.|localStorage\.))/,
    description: "File has 'use client' but may not need it — no hooks, events, or browser globals detected",
  },
  "nextjs-pages-in-app": {
    regex: /./,
    description: "Pages Router convention (index.tsx) inside app/ directory — use page.tsx for App Router",
    fileIncludePattern: /(^|\/)app\/.*\/index\.(tsx|jsx|ts|js)$|^app\/index\.(tsx|jsx|ts|js)$/,
  },
  "nextjs-missing-error-boundary": {
    regex: /./,
    description: "Page file without sibling error.tsx — no error boundary for graceful error handling",
    fileIncludePattern: /(^|\/)app\/.*\/page\.[jt]sx?$/,
  },
  "nextjs-use-client-in-layout": {
    regex: /^[\s\S]{0,512}['"]use client['"]/,
    description: "Layout file with 'use client' — layouts should be Server Components for optimal performance",
    fileIncludePattern: /(^|\/)app\/.*\/layout\.[jt]sx?$|^app\/layout\.[jt]sx?$/,
  },
  "nextjs-missing-metadata": {
    regex: /./,
    description: "Page file without metadata or generateMetadata export — missing SEO metadata",
    fileIncludePattern: /(^|\/)app\/.*\/page\.[jt]sx?$/,
  },
  "nextjs-missing-use-client": {
    // Match files containing client-only API references that do NOT begin with
    // a "use client" / 'use client' / `use client` directive in the first 512 bytes.
    regex: /^(?![\s\S]{0,512}["'`]use client["'`])[\s\S]*(?:useState|useEffect|useRef|useCallback|useMemo|useContext|onClick=|onChange=|onSubmit=)/,
    description: "Client-only API used without 'use client' directive — component will error at build (Next.js App Router)",
    fileIncludePattern: /(^|\/)app\/.*\.(tsx|jsx)$/,
  },

  // --- Hono anti-patterns (Task 15) ---
  "hono-missing-error-handler": {
    regex: /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(\s*\)(?!(?:[\s\S](?!new\s+(?:Hono|OpenAPIHono)))*\.onError)/,
    description: "Hono app created without .onError() handler — unhandled exceptions return 500 with no logging",
  },
  "hono-throw-raw-error": {
    regex: /\(\s*c\s*:\s*Context\s*(?:,\s*next\s*:\s*Next\s*)?\)[\s\S]*?\bthrow\s+new\s+Error\s*\(/,
    description: "throw new Error() inside Hono handler — use HTTPException for proper status code handling",
  },
  "hono-missing-validator": {
    regex: /await\s+c\.req\.(?:json|parseBody)\s*\(\s*\)(?![\s\S]{0,400}?zValidator)/,
    description: "c.req.json()/parseBody() without preceding zValidator — unvalidated request body",
  },
  "hono-unguarded-json-parse": {
    regex: /(?<!try\s*\{[\s\S]{0,200})await\s+c\.req\.json\s*\(\s*\)/,
    description: "await c.req.json() without try/catch — malformed JSON crashes handler",
  },
  "hono-env-type-any": {
    regex: /new\s+Hono\s*\(\s*\)(?!\s*<)/,
    description: "new Hono() without <Env> generic — loses type safety on c.env and c.var",
  },
  "hono-missing-status-code": {
    regex: /\bc\.json\s*\(\s*\{[^}]+\}\s*\)/,
    description: "c.json() without explicit status code — defaults to 200 even for errors/creations",
  },
  "hono-full-app-rpc-export": {
    regex: /export\s+type\s+\w+\s*=\s*typeof\s+app\b/,
    description: "export type X = typeof app — slow RPC pattern (Issue #3869, 8-min CI builds). Use typeof routeGroup instead",
  },

  // --- Database / ORM anti-patterns (db-audit feedback) ---
  "unsafe-raw-sql": {
    regex: /(?:\$queryRawUnsafe|\$executeRawUnsafe|knex\.raw|sequelize\.query|db\.raw)\s*\(\s*[`"'][^`"']*\$\{/,
    description: "Raw SQL with template-string interpolation — SQL injection risk. Use parameterized $queryRaw`...` or query builder. Covers Prisma/Knex/Sequelize/Drizzle.",
  },
  "transaction-external-io": {
    regex: /\$transaction\s*\(\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,2000}?\b(?:fetch|axios|http|stripe|sendgrid|twilio|sendEmail|publishEvent|enqueue)\s*[.(]/,
    description: "External I/O (fetch/HTTP/email/queue) inside Prisma $transaction callback — long-running transactions hold locks. Move I/O after commit.",
  },
  "migration-create-index-no-concurrently": {
    regex: /CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i,
    description: "CREATE INDEX without CONCURRENTLY — locks the table during build. Use CREATE INDEX CONCURRENTLY in PostgreSQL migrations.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-drop-column": {
    regex: /\bALTER\s+TABLE[\s\S]{0,200}\bDROP\s+COLUMN\b/i,
    description: "DROP COLUMN in migration — destructive, breaks rolling deploys. Use multi-step deprecation: stop writes → backfill → drop in next release.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-alter-column-type": {
    regex: /\bALTER\s+TABLE[\s\S]{0,200}\bALTER\s+COLUMN[\s\S]{0,200}\bTYPE\b/i,
    description: "ALTER COLUMN TYPE in migration — full table rewrite, locks table. Use ADD COLUMN + backfill + DROP COLUMN in separate releases.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  "migration-not-null-no-default": {
    regex: /\bADD\s+COLUMN\b[\s\S]{0,200}\bNOT\s+NULL\b(?![\s\S]{0,100}\bDEFAULT\b)/i,
    description: "ADD COLUMN NOT NULL without DEFAULT — fails on existing rows. Add as nullable first, backfill, then add NOT NULL constraint.",
    fileIncludePattern: /\/migrations?\/.*\.sql$/,
  },
  // --- Python anti-patterns ---
  "mutable-default": {
    regex: /def\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|set\s*\(\s*\))/,
    description: "Mutable default argument ([], {}, set()) — shared between calls (Python)",
  },
  "bare-except": {
    regex: /except\s*:/,
    description: "Bare except: catches everything including KeyboardInterrupt (Python)",
  },
  "broad-except": {
    regex: /except\s+(?:Exception|BaseException)\s*:/,
    description: "Broad exception catch — hides real errors (Python)",
  },
  "global-keyword": {
    regex: /\bglobal\s+\w+/,
    description: "global keyword — mutable global state makes code hard to test (Python)",
  },
  "star-import": {
    regex: /from\s+\S+\s+import\s+\*/,
    description: "Star import — pollutes namespace, breaks static analysis (Python)",
  },
  "print-debug-py": {
    regex: /^\s*print\s*\(/m,
    description: "print() in production code — use logging module (Python)",
  },
  "eval-exec": {
    regex: /\b(?:eval|exec)\s*\(/,
    description: "eval()/exec() — code injection risk (Python)",
  },
  "shell-true": {
    regex: /subprocess\.\w+\s*\([^)]*shell\s*=\s*True/,
    description: "subprocess with shell=True — command injection risk (Python)",
  },
  "pickle-load": {
    regex: /pickle\.(?:load|loads)\s*\(/,
    description: "pickle.load/loads — arbitrary code execution from untrusted data (Python)",
  },
  "yaml-unsafe": {
    regex: /yaml\.load\s*\([^)]*\)(?![\s\S]{0,30}Loader)/,
    description: "yaml.load without SafeLoader — arbitrary code execution risk (Python)",
  },
  "open-no-with": {
    regex: /(?<!with\s{1,20})\bopen\s*\([^)]+\)\s*(?:\.\w+|;|$)/m,
    description: "open() without with statement — resource leak if exception occurs (Python)",
  },
  "string-concat-loop": {
    regex: /for\s+\w+\s+in\s+[\s\S]{0,200}?\+=\s*(?:['"]|f['"]|str\()/,
    description: "String concatenation in loop — O(n^2), use join() or list append (Python)",
  },
  "datetime-naive": {
    regex: /datetime\.(?:now|utcnow)\s*\(\s*\)/,
    description: "datetime.now()/utcnow() without timezone — naive datetime causes bugs (Python)",
  },
  "shadow-builtin": {
    regex: /^(?:list|dict|set|id|type|input|map|filter|range|str|int|float|bool|tuple|bytes|object|print|open|format|len|sum|min|max|any|all|zip|enumerate|sorted|reversed|next|iter|super|hash|dir|vars|globals|locals)\s*=/m,
    description: "Assignment shadows Python builtin — breaks code that uses the builtin later (Python)",
  },
  "n-plus-one-django": {
    regex: /for\s+\w+\s+in\s+[\s\S]{0,300}?\.\w+_set\b|\.\w+\.all\(\)/,
    description: "Potential N+1 query — accessing related objects in loop without select_related/prefetch_related (Django)",
  },
  "late-binding": {
    regex: /for\s+(\w+)\s+in\s+[\s\S]{0,200}?lambda\s*[^:]*:\s*\1\b/,
    description: "Late binding closure in loop — all lambdas share last loop value (Python)",
  },
  "assert-tuple": {
    regex: /\bassert\s*\(/,
    description: "assert(expr) — always True because tuple is truthy. Use assert expr without parens (Python)",
  },
};

/**
 * Run optional postFilter on a regex match slice. Returns false if the match
 * should be dropped. If the filter throws, logs a warning and keeps the match
 * (fail-open) so transient postFilter bugs do not hide security findings.
 */
function shouldKeepPostFilterMatch(
  patternKey: string,
  matchText: string,
  postFilter: ((match: string) => boolean) | undefined,
): boolean {
  if (!postFilter) return true;
  try {
    return postFilter(matchText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[search_patterns] postFilter for "${patternKey}" threw: ${msg} — keeping match (fail-open)`,
    );
    return true;
  }
}

type CodeIndex = NonNullable<Awaited<ReturnType<typeof getCodeIndex>>>;
type IndexedSymbol = CodeIndex["symbols"][number];
type IndexedFileEntry = CodeIndex["files"][number];

interface SearchPatternOptions {
  file_pattern?: string | undefined;
  include_tests?: boolean | undefined;
  max_results?: number | undefined;
}

interface SearchPatternSettings {
  includeTests: boolean;
  maxResults: number;
  filePattern?: string;
}

interface PatternExecutionConfig {
  key: string;
  regex: RegExp;
  patternName: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  postFilter?: (match: string) => boolean;
  preprocess?: "strip-comments-strings";
}

interface PatternSearchContext {
  index: CodeIndex;
  config: PatternExecutionConfig;
  settings: SearchPatternSettings;
  matches: PatternMatch[];
  scanned: number;
}

interface PatternScanStrategy {
  name: "symbols" | "files";
  shouldRun: (context: PatternSearchContext) => boolean;
  scan: (context: PatternSearchContext) => Promise<void> | void;
}

type SymbolScanFilter = (sym: IndexedSymbol, context: PatternSearchContext) => boolean;
type FileScanFilter = (fileEntry: IndexedFileEntry, context: PatternSearchContext) => boolean;

const SYMBOL_SCAN_FILTERS: readonly SymbolScanFilter[] = [
  (sym) => Boolean(sym.source),
  (sym, { settings }) => settings.includeTests || !isTestFile(sym.file),
  (sym, { settings }) => !settings.filePattern || sym.file.includes(settings.filePattern),
  (sym, { config }) => !config.fileExcludePattern?.test(sym.file),
  (sym, { config }) => !config.fileIncludePattern || config.fileIncludePattern.test(sym.file),
];

const FILE_SCAN_FILTERS: readonly FileScanFilter[] = [
  (fileEntry, { config }) => config.fileIncludePattern?.test(fileEntry.path) === true,
  (fileEntry, { settings }) => !settings.filePattern || fileEntry.path.includes(settings.filePattern),
  (fileEntry, { config }) => !config.fileExcludePattern?.test(fileEntry.path),
  (fileEntry, { matches }) => !matches.some((match) => match.file === fileEntry.path),
];

function normalizeSearchPatternOptions(options: SearchPatternOptions | undefined): SearchPatternSettings {
  return {
    includeTests: options?.include_tests ?? false,
    maxResults: options?.max_results ?? 50,
    ...(options?.file_pattern ? { filePattern: options.file_pattern } : {}),
  };
}

function resolvePatternConfig(pattern: string): PatternExecutionConfig {
  const builtin = BUILTIN_PATTERNS[pattern];
  if (builtin) {
    return {
      key: pattern,
      regex: builtin.regex,
      patternName: `${pattern}: ${builtin.description}`,
      ...(builtin.fileExcludePattern ? { fileExcludePattern: builtin.fileExcludePattern } : {}),
      ...(builtin.fileIncludePattern ? { fileIncludePattern: builtin.fileIncludePattern } : {}),
      ...(builtin.postFilter ? { postFilter: builtin.postFilter } : {}),
      ...(builtin.preprocess ? { preprocess: builtin.preprocess } : {}),
    };
  }

  try {
    return {
      key: pattern,
      regex: new RegExp(pattern),
      patternName: pattern,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid regex pattern: ${msg}`);
  }
}

function hasMatchCapacity(context: PatternSearchContext): boolean {
  return context.matches.length < context.settings.maxResults;
}

function sourceForPatternScan(source: string, preprocess: PatternExecutionConfig["preprocess"]): string {
  return preprocess === "strip-comments-strings"
    ? stripCommentsAndStrings(source)
    : source;
}

function findAcceptedMatch(config: PatternExecutionConfig, source: string): RegExpExecArray | null {
  const scanSource = sourceForPatternScan(source, config.preprocess);
  const match = config.regex.exec(scanSource);
  if (!match) return null;
  return shouldKeepPostFilterMatch(config.key, match[0], config.postFilter) ? match : null;
}

function matchLineNumber(source: string, matchIndex: number): number {
  return source.slice(0, matchIndex).split("\n").length;
}

function matchedLineText(source: string, match: RegExpExecArray): string {
  const lineEnd = source.indexOf("\n", match.index);
  const originalLine = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd);
  return originalLine.length > 0 ? originalLine : match[0].split("\n")[0]!;
}

function shouldScanSymbol(sym: IndexedSymbol, context: PatternSearchContext): boolean {
  return SYMBOL_SCAN_FILTERS.every((filter) => filter(sym, context));
}

function toSymbolPatternMatch(sym: IndexedSymbol, config: PatternExecutionConfig): PatternMatch | undefined {
  if (!sym.source) return undefined;

  const match = findAcceptedMatch(config, sym.source);
  if (!match) return undefined;

  const linesBefore = matchLineNumber(sym.source, match.index);
  return {
    name: sym.name,
    kind: sym.kind,
    file: sym.file,
    start_line: sym.start_line + linesBefore - 1,
    end_line: sym.end_line,
    matched_pattern: config.patternName,
    context: matchedLineText(sym.source, match).trim().slice(0, 200),
  };
}

function shouldScanFile(fileEntry: IndexedFileEntry, context: PatternSearchContext): boolean {
  return FILE_SCAN_FILTERS.every((filter) => filter(fileEntry, context));
}

async function readIndexedFile(index: CodeIndex, fileEntry: IndexedFileEntry): Promise<string | undefined> {
  try {
    return await readFile(join(index.root, fileEntry.path), "utf-8");
  } catch {
    return undefined;
  }
}

function toFilePatternMatch(
  fileEntry: IndexedFileEntry,
  content: string,
  config: PatternExecutionConfig,
): PatternMatch | undefined {
  const match = findAcceptedMatch(config, content);
  if (!match) return undefined;

  const linesBefore = matchLineNumber(content, match.index);
  return {
    name: fileEntry.path.split("/").pop() ?? fileEntry.path,
    kind: "function" as SymbolKind, // file-level match has no symbol kind
    file: fileEntry.path,
    start_line: linesBefore,
    end_line: linesBefore,
    matched_pattern: config.patternName,
    context: matchedLineText(content, match).trim().slice(0, 200),
  };
}

function scanSymbolEntry(context: PatternSearchContext, sym: IndexedSymbol): PatternMatch | undefined {
  if (!shouldScanSymbol(sym, context)) return undefined;

  context.scanned++;
  return toSymbolPatternMatch(sym, context.config);
}

async function scanFileEntry(
  context: PatternSearchContext,
  fileEntry: IndexedFileEntry,
): Promise<PatternMatch | undefined> {
  if (!shouldScanFile(fileEntry, context)) return undefined;

  const content = await readIndexedFile(context.index, fileEntry);
  if (content === undefined) return undefined;

  context.scanned++;
  return toFilePatternMatch(fileEntry, content, context.config);
}

function scanIndexedSymbols(context: PatternSearchContext): void {
  for (const sym of context.index.symbols) {
    if (!hasMatchCapacity(context)) return;

    const match = scanSymbolEntry(context, sym);
    if (match) context.matches.push(match);
  }
}

async function scanIndexedFiles(context: PatternSearchContext): Promise<void> {
  for (const fileEntry of context.index.files) {
    if (!hasMatchCapacity(context)) return;

    const match = await scanFileEntry(context, fileEntry);
    if (match) context.matches.push(match);
  }
}

const PATTERN_SCAN_STRATEGIES: readonly PatternScanStrategy[] = [
  {
    name: "symbols",
    shouldRun: () => true,
    scan: scanIndexedSymbols,
  },
  {
    name: "files",
    shouldRun: ({ config }) => config.fileIncludePattern !== undefined,
    scan: scanIndexedFiles,
  },
];

/**
 * Search for structural code patterns across indexed symbols.
 * Supports built-in patterns (by name) or custom regex.
 */
export async function searchPatterns(
  repo: string,
  pattern: string,
  options?: SearchPatternOptions,
): Promise<PatternResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const context: PatternSearchContext = {
    index,
    config: resolvePatternConfig(pattern),
    settings: normalizeSearchPatternOptions(options),
    matches: [],
    scanned: 0,
  };

  for (const strategy of PATTERN_SCAN_STRATEGIES) {
    if (!hasMatchCapacity(context)) break;
    if (strategy.shouldRun(context)) await strategy.scan(context);
  }

  return {
    matches: context.matches,
    pattern: context.config.patternName,
    scanned_symbols: context.scanned,
  };
}

/**
 * List all available built-in patterns.
 */
export function listPatterns(): Array<{
  name: string;
  description: string;
  fileExcludePattern?: string;
  fileIncludePattern?: string;
}> {
  return Object.entries(BUILTIN_PATTERNS).map(([name, p]) => ({
    name,
    description: p.description,
    ...(p.fileExcludePattern ? { fileExcludePattern: p.fileExcludePattern.source } : {}),
    ...(p.fileIncludePattern ? { fileIncludePattern: p.fileIncludePattern.source } : {}),
  }));
}
