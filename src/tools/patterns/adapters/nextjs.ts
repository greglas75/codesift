import type { BuiltinPatternDefinition } from "../types.js";

export const NEXTJS_EARLY_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  // Next.js 16 cache patterns (kept at the original catalog position).
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
};

export const NEXTJS_PATTERNS: Record<string, BuiltinPatternDefinition> = {
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
};
