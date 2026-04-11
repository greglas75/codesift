import { getCodeIndex } from "./index-tools.js";
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
}> = {
  "useEffect-no-cleanup": {
    regex: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{(?:(?!return\s*\(\s*\)\s*=>|return\s+\(\)\s*=>|return\s*\(\s*\)\s*\{|return\s+function)[\s\S])*\}\s*,/,
    description: "useEffect without cleanup return — potential memory leak (CQ22)",
  },
  // --- React anti-patterns (Wave 2) ---
  "hook-in-condition": {
    regex: /\b(?:if|for|while|switch)\s*\([^)]*\)\s*\{[^}]*\buse[A-Z]\w*\s*\(/,
    description: "React hook called inside if/for/while/switch — violates Rule of Hooks",
  },
  "useEffect-async": {
    regex: /useEffect\s*\(\s*async\s/,
    description: "async function directly in useEffect — use inner async wrapper (CQ22)",
  },
  "useEffect-object-dep": {
    regex: /useEffect\s*\([\s\S]*?,\s*\[[^\]]*[{[]/,
    description: "Object/array literal in useEffect dependency array — causes infinite re-renders",
  },
  "missing-display-name": {
    regex: /(?:React\.)?(?:memo|forwardRef)\s*\((?:(?!displayName)[\s\S]){0,500}$/,
    description: "React.memo/forwardRef without displayName nearby — harder to debug in DevTools",
  },
  "index-as-key": {
    regex: /\.map\s*\(\s*\(\s*\w+\s*,\s*(index|idx|i)\b[^)]*\)\s*=>[\s\S]{0,400}?key\s*=\s*\{?\s*\1\b/,
    description: "Array index used as React key — causes incorrect reconciliation on reorder",
  },
  "inline-handler": {
    regex: /\bon[A-Z]\w*\s*=\s*\{\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/,
    description: "Inline arrow function in JSX event handler — creates new reference every render (memoization killer)",
  },
  "conditional-render-hook": {
    regex: /\breturn\s+[^;{]*;\s*\n[\s\S]*?\buse[A-Z]\w*\s*\(/,
    description: "React hook called after early return — violates Rule of Hooks",
  },
  // --- React anti-patterns (Wave 4b — additional) ---
  "dangerously-set-html": {
    regex: /dangerouslySetInnerHTML\s*=\s*\{/,
    description: "dangerouslySetInnerHTML used — XSS risk unless content is sanitized (CQ24)",
  },
  "direct-dom-access": {
    regex: /\bdocument\.(getElementById|querySelector|querySelectorAll|getElementsBy)\s*\(/,
    description: "Direct DOM access in React component — use useRef instead (breaks SSR, bypasses virtual DOM)",
  },
  "unstable-default-value": {
    regex: /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=\s*(?:\([^)]*\)|[^=]*)\s*=>)\s*[\s\S]{0,100}(?:\{\s*[^}]*=\s*\[\s*\]|\{\s*[^}]*=\s*\{\s*\})/,
    description: "Default prop value [] or {} in component params — creates new reference every render, breaks memo/PureComponent",
  },
  "jsx-falsy-and": {
    regex: /\{\s*(?:count|length|size|num|total|amount)\s*&&\s*</,
    description: "Numeric variable used with && in JSX — renders '0' on screen when falsy. Use ternary or Boolean() (React gotcha)",
  },
  "nested-component-def": {
    regex: /(?:function|const)\s+[A-Z]\w*\s*(?:=\s*(?:\([^)]*\)\s*=>|\(\)\s*=>)|(?:\([^)]*\)\s*\{))[\s\S]{0,2000}?(?:function|const)\s+[A-Z]\w*\s*(?:=\s*\(|[\s\S]{0,50}?return\s*(?:<|\())/,
    description: "Component defined inside another component — remounts on every parent render, loses all state. Hoist to module level.",
  },
  "usecallback-no-deps": {
    regex: /use(?:Callback|Memo)\s*\([\s\S]*?\)\s*\)\s*[;,]/,
    description: "useCallback/useMemo with only one argument (no dependency array) — useless memoization, value recreated every render",
  },
  "empty-catch": {
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    description: "Empty catch block — swallowed error (CQ8)",
  },
  "any-type": {
    regex: /:\s*any\b|as\s+any\b/,
    description: "Usage of 'any' type — lose type safety",
  },
  "console-log": {
    regex: /console\.(log|debug|info)\s*\(/,
    description: "console.log in production code — use structured logger (CQ13)",
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
  // Astro anti-patterns
  "astro-client-on-astro": {
    regex: /client:(load|idle|visible|media|only).*\.astro/,
    description: "client directive on .astro component import (Astro components cannot hydrate)",
  },
  "astro-glob-usage": {
    regex: /Astro\.glob\s*\(/,
    description: "deprecated Astro.glob() — use getCollection() or import.meta.glob()",
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
    description: "legacy content collection config — migrate to src/content.config.ts",
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
};

/**
 * Search for structural code patterns across indexed symbols.
 * Supports built-in patterns (by name) or custom regex.
 */
export async function searchPatterns(
  repo: string,
  pattern: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
    max_results?: number | undefined;
  },
): Promise<PatternResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 50;

  // Resolve pattern: built-in name or custom regex
  let regex: RegExp;
  let patternName: string;
  let fileExcludePattern: RegExp | undefined;
  let fileIncludePattern: RegExp | undefined;

  const builtin = BUILTIN_PATTERNS[pattern];
  if (builtin) {
    regex = builtin.regex;
    patternName = `${pattern}: ${builtin.description}`;
    fileExcludePattern = builtin.fileExcludePattern;
    fileIncludePattern = builtin.fileIncludePattern;
  } else {
    try {
      regex = new RegExp(pattern);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${msg}`);
    }
    patternName = pattern;
  }

  const matches: PatternMatch[] = [];
  let scanned = 0;

  for (const sym of index.symbols) {
    if (matches.length >= maxResults) break;
    if (!sym.source) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (fileExcludePattern && fileExcludePattern.test(sym.file)) continue;
    if (fileIncludePattern && !fileIncludePattern.test(sym.file)) continue;

    scanned++;
    const match = regex.exec(sym.source);
    if (match) {
      // Extract context: the matching line(s)
      const matchStart = match.index;
      const linesBefore = sym.source.slice(0, matchStart).split("\n").length;
      const matchedText = match[0].split("\n")[0]!; // First line of match

      matches.push({
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line + linesBefore - 1,
        end_line: sym.end_line,
        matched_pattern: patternName,
        context: matchedText.trim().slice(0, 200),
      });
    }
  }

  return {
    matches,
    pattern: patternName,
    scanned_symbols: scanned,
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

