# Implementation Plan: CodeSift Landing Page

**Spec:** `docs/specs/2026-03-27-landing-page-spec.md`
**Created:** 2026-03-27
**Tasks:** 12
**Estimated complexity:** 9 standard, 3 complex

## Architecture Summary

New repo `codesift-website`. 14 components: 11 Astro (static HTML) + 3 React islands (CopyButton, Terminal, ThemeToggle). Data layer: `stats.ts`, `features.ts`, `github.ts` (build-time star fetch). Design tokens copied from `codesift-dashboard` (global.css + tailwind.config.mjs). No API routes, no database — pure Astro SSG deployed to Cloudflare Pages.

Component hierarchy:
```
BaseLayout.astro (theme flash script, <head>, SEO meta)
  └── index.astro
        ├── Nav.astro → ThemeToggle.tsx (island)
        ├── Hero.astro → CopyButton.tsx (island) + Terminal.tsx (island)
        ├── SocialProof.astro (build-time GitHub stars)
        ├── Problem.astro
        ├── FeatureGrid.astro → FeatureCard.astro
        ├── Benchmarks.astro
        ├── HowItWorks.astro (Shiki <Code>)
        ├── Comparison.astro
        ├── Pricing.astro
        └── Footer.astro
```

## Technical Decisions

- **Animations:** CSS-only `.animate-in-*` from dashboard — no library
- **Terminal:** Built from scratch (~60 lines React island, state machine)
- **Code highlighting:** Astro built-in `<Code>` (Shiki, zero client JS)
- **Fonts:** Self-hosted via `@fontsource-variable/lexend` + `@fontsource/red-hat-mono`
- **SEO:** `@astrojs/sitemap` + manual `robots.txt` + static OG image
- **No new animation/UI libraries** — everything via Tailwind + dashboard CSS tokens

## Quality Strategy

- **Test framework:** Vitest (two projects: `jsdom` for React islands, `node` for data modules)
- **Astro components:** NOT unit-tested — `astro build` exit 0 is the integration gate
- **CQ gates activated:** CQ8 (github.ts fetch + clipboard API), CQ14 (token drift — tracked), CQ22 (Terminal interval cleanup)
- **Highest risks:** Terminal interval leak (#1), github.ts build failure (#2), ThemeToggle hydration flash (#3)
- **Post-build CI checks:** robots.txt exists, sitemap exists, OG meta tags present in dist/index.html

## Task Breakdown

### Task 1: Project scaffolding
**Files:** `package.json`, `astro.config.mjs`, `tsconfig.json`, `tailwind.config.mjs`, `vitest.config.ts`
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Verify project builds
  ```bash
  # No test file — this is configuration. The "red" state is that the project doesn't exist yet.
  # Verification is: astro build succeeds with zero errors.
  ```
- [ ] GREEN: Scaffold the project
  ```bash
  mkdir codesift-website && cd codesift-website
  npm create astro@latest -- --template minimal --no-install
  npm install astro @astrojs/react @astrojs/tailwind @astrojs/sitemap react react-dom tailwindcss
  npm install -D vitest @testing-library/react @testing-library/jest-dom happy-dom typescript
  npm install @fontsource-variable/lexend @fontsource/red-hat-mono
  ```
  Create `astro.config.mjs`:
  ```javascript
  import { defineConfig } from 'astro/config';
  import react from '@astrojs/react';
  import tailwind from '@astrojs/tailwind';
  import sitemap from '@astrojs/sitemap';

  export default defineConfig({
    site: 'https://codesift.app',
    output: 'static',
    integrations: [react(), tailwind(), sitemap()],
  });
  ```
  Copy `tailwind.config.mjs` from `codesift-dashboard` — update `content` glob to `['./src/**/*.{astro,html,js,jsx,ts,tsx}']`.
  Create `vitest.config.ts` with two projects: `islands` (happy-dom) and `data` (node).
- [ ] Verify: `cd codesift-website && npx astro build`
  Expected: Build succeeds, `dist/` directory created
- [ ] Commit: `feat: scaffold codesift-website — Astro 5 SSG + Tailwind + React + Vitest`

---

### Task 2: Design tokens + base styles
**Files:** `src/styles/global.css`, `public/favicon.svg`, `public/robots.txt`
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] RED: N/A — static assets, no testable behavior
- [ ] GREEN: Copy `src/styles/global.css` from `codesift-dashboard` verbatim. Add font imports at top:
  ```css
  @import '@fontsource-variable/lexend';
  @import '@fontsource/red-hat-mono';
  ```
  Create minimal `public/favicon.svg` (extract logo SVG path from dashboard Sidebar.astro).
  Create `public/robots.txt`:
  ```
  User-agent: *
  Allow: /
  Sitemap: https://codesift.app/sitemap-index.xml
  ```
- [ ] Verify: `npx astro build && test -f dist/robots.txt && grep -q 'Sitemap' dist/robots.txt`
  Expected: Build succeeds, robots.txt present with Sitemap line
- [ ] Commit: `feat: add design tokens (Midnight Observatory theme) + favicon + robots.txt`

---

### Task 3: Data modules + tests
**Files:** `src/data/stats.ts`, `src/data/features.ts`, `src/data/github.ts`, `tests/data/stats.test.ts`, `tests/data/features.test.ts`, `tests/data/github.test.ts`
**Complexity:** complex
**Dependencies:** Task 1
**Model routing:** Opus

- [ ] RED: Write failing tests
  ```typescript
  // tests/data/stats.test.ts
  import { describe, it, expect } from 'vitest';
  import { STATS } from '../../src/data/stats';

  describe('STATS', () => {
    it('exports all required marketing numbers', () => {
      expect(STATS.tools).toBeTypeOf('number');
      expect(STATS.tools).toBeGreaterThan(0);
      expect(STATS.tokenSavingsPercent).toBeTypeOf('number');
      expect(STATS.languages).toBeTypeOf('number');
      expect(STATS.reindexSpeedup).toBeTruthy();
      expect(STATS.tests).toBeTruthy();
    });
  });

  // tests/data/features.test.ts
  import { describe, it, expect } from 'vitest';
  import { FEATURES } from '../../src/data/features';

  describe('FEATURES', () => {
    it('exports a non-empty array of features', () => {
      expect(FEATURES.length).toBeGreaterThan(0);
    });

    it('each feature has required fields', () => {
      for (const f of FEATURES) {
        expect(f.title).toBeTruthy();
        expect(f.description).toBeTruthy();
        expect(f.icon).toBeTruthy();
      }
    });

    it('has no duplicate titles', () => {
      const titles = FEATURES.map(f => f.title);
      expect(new Set(titles).size).toBe(titles.length);
    });
  });

  // tests/data/github.test.ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { fetchStars } from '../../src/data/github';

  describe('fetchStars', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns star count from valid API response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ stargazers_count: 1234 }),
      }));
      const result = await fetchStars('owner/repo');
      expect(result).toBe(1234);
    });

    it('returns null when fetch throws (network error)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      const result = await fetchStars('owner/repo');
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));
      const result = await fetchStars('owner/repo');
      expect(result).toBeNull();
    });

    it('returns null when JSON shape is unexpected', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: 'shape' }),
      }));
      const result = await fetchStars('owner/repo');
      expect(result).toBeNull();
    });
  });
  ```
- [ ] GREEN: Implement data modules
  ```typescript
  // src/data/stats.ts
  export const STATS = {
    tools: 39,
    languages: 12,
    tokenSavingsPercent: 33,
    reindexSpeedup: '5.6x',
    searchQuality: '7.8/10',
    searchQualityBaseline: '6.5/10',
    avgTokensPerCall: 997,
    tests: '458+',
  } as const;

  // src/data/features.ts
  export interface Feature {
    icon: string;
    title: string;
    description: string;
    badge?: 'pro' | 'optional';
  }

  export const FEATURES: Feature[] = [
    {
      icon: 'search',
      title: 'Intelligent Search',
      description: 'BM25F ranking with centrality bonus. Semantic search with embeddings. Token-budget-aware results.',
      badge: 'optional',
    },
    {
      icon: 'graph',
      title: 'Code Graph',
      description: 'Call chains, impact analysis, HTTP route tracing. Understand how your code connects.',
    },
    {
      icon: 'lsp',
      title: 'LSP Bridge',
      description: 'Go-to-definition, type info, cross-file rename. Language server precision without the setup.',
      badge: 'optional',
    },
    {
      icon: 'analysis',
      title: 'Analysis Suite',
      description: 'Dead code, complexity ranking, clone detection, hotspots, 9 built-in anti-patterns.',
    },
    {
      icon: 'cross-repo',
      title: 'Cross-Repo Search',
      description: 'Search symbols and text across all indexed repos. One query, all your projects.',
    },
    {
      icon: 'context',
      title: 'Context Levels',
      description: 'L0 full source to L3 directory overview. Control token density per query.',
    },
  ];

  // src/data/github.ts
  export async function fetchStars(repo: string): Promise<number | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data?.stargazers_count !== 'number') return null;
      return data.stargazers_count;
    } catch {
      return null;
    }
  }
  ```
- [ ] Verify: `npx vitest run tests/data/`
  Expected: 8 tests passed, 0 failed
- [ ] Commit: `feat: add data modules (stats, features, github stars) with tests`

---

### Task 4: BaseLayout + SEO meta
**Files:** `src/layouts/BaseLayout.astro`
**Complexity:** standard
**Dependencies:** Task 2
**Model routing:** Sonnet

- [ ] RED: N/A — Astro layout, tested via build
- [ ] GREEN: Create `src/layouts/BaseLayout.astro`:
  - `<html lang="en" data-theme="dark">`
  - `<head>` with: charset, viewport, title, meta description, canonical, OG tags, Twitter Card tags, JSON-LD SoftwareApplication, font CSS import, global.css import
  - Theme flash prevention `<script is:inline>` that reads `localStorage('codesift-theme')` and sets `data-theme` before paint
  - `astro:after-swap` listener for ViewTransitions
  - `<body>` with `<slot />`
- [ ] Verify: `npx astro build`
  Expected: Build succeeds. `dist/index.html` (once index.astro exists) will contain OG tags.
- [ ] Commit: `feat: add BaseLayout with SEO meta, OG tags, theme flash prevention`

---

### Task 5: CopyButton island + tests
**Files:** `src/components/CopyButton.tsx`, `tests/islands/CopyButton.test.tsx`
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```tsx
  // tests/islands/CopyButton.test.tsx
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { render, screen, act } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import { CopyButton } from '../../src/components/CopyButton';

  describe('CopyButton', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('copies text to clipboard on click', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<CopyButton code="npm install -g codesift-mcp" />);
      await user.click(screen.getByRole('button'));

      expect(writeText).toHaveBeenCalledWith('npm install -g codesift-mcp');
    });

    it('shows copied state then resets', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<CopyButton code="npm install -g codesift-mcp" />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByRole('button')).toHaveTextContent(/copied/i);

      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole('button')).not.toHaveTextContent(/copied/i);
    });

    it('handles clipboard API unavailable', async () => {
      Object.assign(navigator, { clipboard: undefined });

      render(<CopyButton code="npm install -g codesift-mcp" />);
      // Button should still render but not crash
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });
  ```
- [ ] GREEN: Implement CopyButton
  ```tsx
  // src/components/CopyButton.tsx
  import { useState } from 'react';

  interface Props {
    code: string;
    label?: string;
  }

  export function CopyButton({ code, label = 'Copy' }: Props) {
    const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

    async function handleClick() {
      try {
        await navigator.clipboard.writeText(code);
        setState('copied');
        setTimeout(() => setState('idle'), 2000);
      } catch {
        setState('error');
        setTimeout(() => setState('idle'), 2000);
      }
    }

    const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;

    return (
      <button
        onClick={canCopy ? handleClick : undefined}
        className="..."
        aria-label={state === 'copied' ? 'Copied!' : `Copy ${label}`}
      >
        {state === 'copied' ? 'Copied!' : label}
      </button>
    );
  }
  ```
- [ ] Verify: `npx vitest run tests/islands/CopyButton.test.tsx`
  Expected: 3 tests passed
- [ ] Commit: `feat: add CopyButton island with clipboard copy + fallback`

---

### Task 6: Terminal island + tests
**Files:** `src/components/Terminal.tsx`, `tests/islands/Terminal.test.tsx`
**Complexity:** complex
**Dependencies:** Task 1
**Model routing:** Opus

- [ ] RED: Write failing test
  ```tsx
  // tests/islands/Terminal.test.tsx
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { render, screen, act } from '@testing-library/react';
  import { Terminal } from '../../src/components/Terminal';

  const LINES = [
    { type: 'command' as const, text: '$ npm install -g codesift-mcp' },
    { type: 'output' as const, text: 'added 42 packages' },
    { type: 'command' as const, text: '$ codesift search local/myproject "auth"' },
    { type: 'output' as const, text: 'Found 12 results (avg 1,291 tok)' },
  ];

  describe('Terminal', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('renders with initial empty state', () => {
      render(<Terminal lines={LINES} />);
      expect(screen.getByRole('region', { name: /terminal/i })).toBeInTheDocument();
    });

    it('types out lines progressively', () => {
      render(<Terminal lines={LINES} typingSpeed={50} />);
      // Advance through first command character by character
      act(() => { vi.advanceTimersByTime(50 * LINES[0].text.length + 500); });
      expect(screen.getByText(/npm install/)).toBeInTheDocument();
    });

    it('cleans up interval on unmount (CQ22)', () => {
      const { unmount } = render(<Terminal lines={LINES} />);
      unmount();
      // Advancing timers after unmount should not throw
      expect(() => {
        act(() => { vi.advanceTimersByTime(10000); });
      }).not.toThrow();
    });
  });
  ```
- [ ] GREEN: Implement Terminal island (~60 lines)
  - State machine: `lineIndex`, `charIndex`, `phase` (typing/paused/output)
  - Single `useEffect` with `setInterval`, cleanup via `clearInterval` in return
  - `useRef` for interval handle to avoid stale closures
  - Props: `lines: TerminalLine[]`, `typingSpeed?: number`
  - Renders: dark rounded box with monospace font, green prompt, white output
- [ ] Verify: `npx vitest run tests/islands/Terminal.test.tsx`
  Expected: 3 tests passed
- [ ] Commit: `feat: add Terminal island with typewriter animation + cleanup`

---

### Task 7: ThemeToggle island + tests
**Files:** `src/components/ThemeToggle.tsx`, `tests/islands/ThemeToggle.test.tsx`
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```tsx
  // tests/islands/ThemeToggle.test.tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import { ThemeToggle } from '../../src/components/ThemeToggle';

  describe('ThemeToggle', () => {
    beforeEach(() => {
      localStorage.clear();
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    it('reads initial theme from document element', () => {
      render(<ThemeToggle />);
      expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
    });

    it('toggles theme on click', async () => {
      const user = userEvent.setup();
      render(<ThemeToggle />);
      await user.click(screen.getByRole('button', { name: /theme/i }));
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(localStorage.getItem('codesift-theme')).toBe('light');
    });

    it('toggles back to dark on second click', async () => {
      const user = userEvent.setup();
      render(<ThemeToggle />);
      await user.click(screen.getByRole('button', { name: /theme/i }));
      await user.click(screen.getByRole('button', { name: /theme/i }));
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });
  ```
- [ ] GREEN: Implement ThemeToggle (~40 lines)
  - `useState(() => document.documentElement.getAttribute('data-theme') ?? 'dark')`
  - Toggle function: flip value, set on `documentElement`, persist to `localStorage`
  - Sun/moon icon swap
- [ ] Verify: `npx vitest run tests/islands/ThemeToggle.test.tsx`
  Expected: 3 tests passed
- [ ] Commit: `feat: add ThemeToggle island with localStorage persistence`

---

### Task 8: Nav + Hero + SocialProof sections
**Files:** `src/components/Nav.astro`, `src/components/Hero.astro`, `src/components/SocialProof.astro`
**Complexity:** complex
**Dependencies:** Task 4, Task 5, Task 6, Task 7
**Model routing:** Opus

- [ ] RED: N/A — Astro components, tested via build
- [ ] GREEN: Create three above-the-fold sections:
  **Nav.astro:** Sticky top bar with: logo text, anchor links (Features, Benchmarks, Install), GitHub link, "Get Started" CTA button, ThemeToggle island. `position: sticky; top: 0; z-index: 50;` with glass backdrop blur.
  **Hero.astro:** H1 "Code intelligence for AI agents", subhead with 33% stat, two CTAs (CopyButton island with `npm install -g codesift-mcp` + "View on GitHub" link), Terminal island below. Full-width, centered, generous padding.
  **SocialProof.astro:** "Works with" logos (Claude Code, Cursor, Codex) + GitHub star count (from `github.ts` build-time fetch, fallback to null = hidden). Muted single row below hero.
- [ ] Verify: `npx astro build`
  Expected: Build succeeds
- [ ] Commit: `feat: add Nav, Hero, and SocialProof sections (above the fold)`

---

### Task 9: Problem + FeatureGrid + Benchmarks sections
**Files:** `src/components/Problem.astro`, `src/components/FeatureGrid.astro`, `src/components/FeatureCard.astro`, `src/components/Benchmarks.astro`
**Complexity:** standard
**Dependencies:** Task 3 (features.ts, stats.ts), Task 2 (global.css)
**Model routing:** Sonnet

- [ ] RED: N/A — Astro components
- [ ] GREEN: Create three mid-page sections:
  **Problem.astro:** 2-3 sentence prose block. "AI coding agents are blind to your codebase structure. Grep doesn't understand meaning. Reading whole files wastes context." Centered, max-width prose, `.animate-in`.
  **FeatureGrid.astro:** Imports `FEATURES` from `features.ts`. Maps to `FeatureCard.astro` in 3-column grid (stacks on mobile). Each card uses `.glass` class. Features with `badge: 'optional'` show "requires setup" chip.
  **FeatureCard.astro:** Single card component. Props: Feature interface. Icon + title + description + optional badge. `.glass` + `.animate-in-{N}`.
  **Benchmarks.astro:** 4 large-format stats from `stats.ts`: -33% tokens, 39 tools, 5.6x reindex, 7.8/10 quality. Monospace numbers, `.font-mono`, large text. `.animate-in` stagger.
- [ ] Verify: `npx astro build`
  Expected: Build succeeds
- [ ] Commit: `feat: add Problem, FeatureGrid, and Benchmarks sections`

---

### Task 10: HowItWorks + Comparison + Pricing sections
**Files:** `src/components/HowItWorks.astro`, `src/components/Comparison.astro`, `src/components/Pricing.astro`
**Complexity:** standard
**Dependencies:** Task 2 (global.css), Task 5 (CopyButton)
**Model routing:** Sonnet

- [ ] RED: N/A — Astro components
- [ ] GREEN: Create three lower-page sections:
  **HowItWorks.astro:** 3 numbered steps with Shiki `<Code>` blocks:
  1. Install: `npm install -g codesift-mcp` (with CopyButton)
  2. Configure: MCP config JSON snippet
  3. Query: example `search_symbols` call + result
  `.animate-in` stagger per step.

  **Comparison.astro:** Semantic `<table>` — CodeSift vs "Traditional tools (grep/Read)". Rows: Semantic search, AST awareness, Token efficiency, Call graph, Cross-repo, LSP integration, Dead code detection. Checkmark/X icons. Responsive: horizontally scrollable on mobile.

  **Pricing.astro:** Two `.glass` cards side by side:
  - Free: "Free to start", feature list (35 tools, 3 repos, BM25 search, ...)
  - Pro: "Coming soon — $79/yr", feature list (unlimited repos, semantic search, analysis suite, all skills, ...), "Notify me" placeholder
- [ ] Verify: `npx astro build`
  Expected: Build succeeds
- [ ] Commit: `feat: add HowItWorks, Comparison, and Pricing sections`

---

### Task 11: Footer + 404 page
**Files:** `src/components/Footer.astro`, `src/pages/404.astro`
**Complexity:** standard
**Dependencies:** Task 4
**Model routing:** Sonnet

- [ ] RED: N/A — Astro components
- [ ] GREEN:
  **Footer.astro:** Links grid: GitHub, npm, Docs (placeholder), License, Privacy Policy (placeholder). Copyright "2026 CodeSift". Subtle top border. Muted text colors.
  **404.astro:** Uses BaseLayout. Simple centered message: "Page not found" + link back to homepage.
- [ ] Verify: `npx astro build && test -f dist/404.html`
  Expected: Build succeeds, 404.html exists in dist/
- [ ] Commit: `feat: add Footer and 404 page`

---

### Task 12: Page assembly + build verification
**Files:** `src/pages/index.astro`, `public/og-image.png`
**Complexity:** complex
**Dependencies:** Task 8, Task 9, Task 10, Task 11
**Model routing:** Opus

- [ ] RED: Write post-build verification script
  ```bash
  # tests/build-check.sh
  set -e
  npx astro build
  echo "--- Build artifact checks ---"
  test -f dist/index.html && echo "PASS: index.html exists"
  test -f dist/404.html && echo "PASS: 404.html exists"
  test -f dist/robots.txt && echo "PASS: robots.txt exists"
  grep -q 'og:title' dist/index.html && echo "PASS: OG title present"
  grep -q 'og:image' dist/index.html && echo "PASS: OG image present"
  grep -q 'twitter:card' dist/index.html && echo "PASS: Twitter card present"
  grep -q 'application/ld+json' dist/index.html && echo "PASS: JSON-LD present"
  grep -q 'Code intelligence' dist/index.html && echo "PASS: Hero headline present"
  grep -q 'npm install' dist/index.html && echo "PASS: Install command present"
  grep -q 'noopener' dist/index.html && echo "PASS: External links have rel=noopener"
  grep -q 'prefers-reduced-motion' dist/styles/*.css 2>/dev/null || grep -q 'prefers-reduced-motion' dist/_astro/*.css 2>/dev/null && echo "PASS: Reduced motion respected"
  echo "All checks passed."
  echo "--- Manual checks required before launch ---"
  echo "- AC12: WCAG 2.1 AA color contrast (run axe-core or Lighthouse a11y)"
  echo "- AC1: LCP < 2.5s on throttled 4G (run Lighthouse on deployed URL)"
  ```
- [ ] GREEN: Create `src/pages/index.astro`:
  ```astro
  ---
  import BaseLayout from '../layouts/BaseLayout.astro';
  import Nav from '../components/Nav.astro';
  import Hero from '../components/Hero.astro';
  import SocialProof from '../components/SocialProof.astro';
  import Problem from '../components/Problem.astro';
  import FeatureGrid from '../components/FeatureGrid.astro';
  import Benchmarks from '../components/Benchmarks.astro';
  import HowItWorks from '../components/HowItWorks.astro';
  import Comparison from '../components/Comparison.astro';
  import Pricing from '../components/Pricing.astro';
  import Footer from '../components/Footer.astro';
  ---

  <BaseLayout title="CodeSift — Code intelligence for AI agents" description="39 MCP tools that give Claude Code, Cursor, and Codex deep understanding of your codebase — with 33% fewer tokens than grep.">
    <Nav />
    <main>
      <Hero />
      <SocialProof />
      <Problem />
      <FeatureGrid />
      <Benchmarks />
      <HowItWorks />
      <Comparison />
      <Pricing />
    </main>
    <Footer />
  </BaseLayout>
  ```
  Add placeholder `public/og-image.png` (1200x630, can be a simple branded image for now).
- [ ] Verify: `bash tests/build-check.sh`
  Expected: All checks passed
- [ ] Commit: `feat: assemble landing page — all 10 sections + build verification`
