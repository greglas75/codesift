import type { BuiltinPatternDefinition } from "../types.js";

export const REACT_PATTERNS_BEFORE_NEXTJS: Record<string, BuiltinPatternDefinition> = {
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
};

export const REACT_PATTERNS_AFTER_NEXTJS: Record<string, BuiltinPatternDefinition> = {
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
};
