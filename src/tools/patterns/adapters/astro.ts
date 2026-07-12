import type { BuiltinPatternDefinition } from "../types.js";

export const ASTRO_PATTERNS: Record<string, BuiltinPatternDefinition> = {
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
};
