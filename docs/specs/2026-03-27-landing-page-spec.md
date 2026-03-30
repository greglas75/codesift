# CodeSift Landing Page — Design Specification

> **Date:** 2026-03-27
> **Status:** Approved
> **Author:** zuvo:brainstorm

## Problem Statement

CodeSift has 39 MCP tools, benchmarked 20-33% token savings, BM25+semantic+LSP (unique in market), and a working dashboard — but zero public presence. No website, no npm publish, not in awesome-mcp-servers, 0 GitHub stars. Competitors GitNexus (19.5K★) and Serena (22K★) dominate visibility despite fewer capabilities.

Without a landing page, there is no conversion point: developers who hear about CodeSift have nowhere to go to understand what it does, install it, or evaluate it against alternatives.

## Design Decisions

### D1: Separate repo (not in dashboard)
**Chosen:** New `codesift-website` repo, Astro SSG, deployed independently.
**Why:** Landing page is a static marketing site. Dashboard is SSR with live data. Mixing them couples deploy cycles and complicates the build. Separate repos allow independent evolution.
**Rejected:** Adding pages to `codesift-dashboard` — would require SSR for marketing pages, shared deploy pipeline.

### D2: Astro SSG + Tailwind + React islands
**Chosen:** Same stack as dashboard but in SSG mode (`output: 'static'`).
**Why:** Proven stack, design tokens can be shared, zero-JS by default for Lighthouse ~100, React islands only for interactive elements (copy button, terminal animation).
**Rejected:** Next.js (overkill for static site), plain HTML (no component reuse).

### D3: Cloudflare Pages deployment
**Chosen:** Cloudflare Pages with `codesift.app` domain.
**Why:** DNS already on Cloudflare. Free tier is generous (unlimited bandwidth, 500 builds/mo). Edge CDN for fast global delivery. Native Astro adapter available.
**Rejected:** Vercel (would split infra — DNS on Cloudflare, hosting on Vercel).

### D4: Soft pricing teaser (not full pricing page)
**Chosen:** "Free to start" prominently displayed + "Pro coming soon" section with premium feature list.
**Why:** Product is not yet publicly available. Full pricing before traction risks scaring early adopters. Teaser builds awareness of premium tier without requiring Stripe integration.
**Rejected:** Full pricing table (premature), no pricing mention (misses opportunity to signal commercial intent).

### D5: Commercial license (not MIT)
**Chosen:** License will change from MIT to a commercial-friendly license (exact license TBD — separate task).
**Why:** Future Pro tier ($79/yr) requires license that allows gating features. MIT makes this impossible to enforce.
**Impact on landing page:** Display "Free for personal use" instead of "MIT licensed". Link to license terms page.

### D6: No analytics on launch
**Chosen:** Launch without analytics. Add self-hosted Plausible later.
**Why:** Reduces launch scope. Plausible self-hosted requires a VPS. Can be added post-launch without any code changes (one `<script>` tag).

### D7: Dark-first design
**Chosen:** Dark mode default, optional light toggle. Deep navy base (not pure black), single accent color, monospace for metrics/code.
**Why:** Developer audience expects dark. All best-in-class dev tool sites (Linear, Raycast, Vercel) default to dark. Dashboard already uses "Midnight Observatory" dark theme — landing page inherits the aesthetic.

## Solution Overview

A single-page marketing website at `codesift.app` built with Astro SSG. The page scrolls through 10 sections designed to convert a developer from "what is this?" to "npm install". All content is static at build time — no runtime API calls. Interactive elements (copy-to-clipboard, theme toggle) use minimal React islands.

```
┌─────────────────────────────────────┐
│  Sticky Nav                         │
│  Logo · Features · Benchmarks ·     │
│  Install · GitHub         [CTA]     │
├─────────────────────────────────────┤
│  Hero                               │
│  "Code intelligence for AI agents"  │
│  Subhead + npm install [copy] +     │
│  Animated terminal demo             │
├─────────────────────────────────────┤
│  Social Proof Bar                   │
│  Claude Code · Cursor · Codex logos │
│  + GitHub stars (build-time fetch)  │
├─────────────────────────────────────┤
│  Problem Statement                  │
│  "AI agents are blind to your       │
│   codebase structure..."            │
├─────────────────────────────────────┤
│  Feature Grid (5-6 cards)           │
│  Search · Analysis · LSP · Graph ·  │
│  Cross-repo · Context Levels        │
├─────────────────────────────────────┤
│  Benchmarks (big numbers)           │
│  -33% tokens · 39 tools · 5.6x     │
│  reindex · +20% search quality      │
├─────────────────────────────────────┤
│  How It Works (3 steps)             │
│  1. npm install  2. MCP config      │
│  3. First query (Shiki code blocks) │
├─────────────────────────────────────┤
│  Comparison Table                   │
│  CodeSift vs traditional tools      │
│  (checkmarks, token savings)        │
├─────────────────────────────────────┤
│  Pricing Teaser                     │
│  "Free to start" + Pro coming soon  │
│  Premium feature list               │
├─────────────────────────────────────┤
│  Footer                             │
│  GitHub · npm · Docs · License ·    │
│  Privacy · © 2026                   │
└─────────────────────────────────────┘
```

## Detailed Design

### Data Model

No database. All content is static markdown/Astro components. Build-time data:

```typescript
// src/data/stats.ts — single source of truth for marketing numbers
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

// src/data/features.ts — feature card definitions
export interface Feature {
  icon: string;       // SVG icon name
  title: string;
  description: string;
  badge?: 'pro' | 'optional';  // for semantic search, LSP
}
```

GitHub stars fetched at build time via GitHub API and baked into static HTML.

### API Surface

No runtime API. The landing page is fully static.

**Build-time fetches:**
- `https://api.github.com/repos/{owner}/codesift-mcp` → `stargazers_count` (cached at build)
- No `/api/metrics` dependency — all numbers come from `stats.ts`

### Integration Points

**Shared with dashboard (copy, not import):**
- CSS variables from `codesift-dashboard/src/styles/global.css` → copy design tokens (colors, spacing, typography) into the website repo
- Tailwind config color aliases (`base`, `surface`, `elevated`, `hover`, `border`, `accent`)
- No runtime dependency between the two repos

**External integrations:**
- **Cloudflare Pages** — Astro adapter `@astrojs/cloudflare` for deployment
- **GitHub API** — build-time star count fetch (no auth needed for public repos, rate limit 60/hr sufficient for builds)
- **Shiki** — Astro's built-in syntax highlighter for code blocks (server-side, zero runtime JS)

**Files to create (new repo `codesift-website`):**
```
codesift-website/
├── astro.config.mjs          # SSG + Cloudflare adapter
├── tailwind.config.mjs        # Design tokens (from dashboard)
├── package.json
├── tsconfig.json
├── public/
│   ├── favicon.svg
│   ├── og-image.png           # 1200x630 social share image
│   ├── robots.txt
│   └── sitemap.xml            # or auto-generated by @astrojs/sitemap
├── src/
│   ├── data/
│   │   ├── stats.ts           # Marketing numbers (single source of truth)
│   │   └── features.ts        # Feature card definitions
│   ├── styles/
│   │   └── global.css         # Design tokens + base styles
│   ├── layouts/
│   │   └── LandingLayout.astro # Full-width, no sidebar
│   ├── components/
│   │   ├── Nav.astro           # Sticky navigation
│   │   ├── Hero.astro          # Headline + CTAs + terminal
│   │   ├── SocialProof.astro   # Client logos + stars
│   │   ├── Problem.astro       # Problem statement
│   │   ├── FeatureGrid.astro   # 5-6 feature cards
│   │   ├── Benchmarks.astro    # Big number stats
│   │   ├── HowItWorks.astro    # 3-step install guide
│   │   ├── Comparison.astro    # vs traditional tools table
│   │   ├── Pricing.astro       # Free + Pro teaser
│   │   ├── Footer.astro        # Links + legal
│   │   ├── CopyButton.tsx      # React island — clipboard
│   │   ├── Terminal.tsx         # React island — animated demo
│   │   └── ThemeToggle.tsx     # React island — dark/light
│   └── pages/
│       ├── index.astro         # Main landing page
│       └── 404.astro           # Not found page
```

### Edge Cases

**EC1: GitHub API rate limit at build time**
- Scenario: Build fetches star count but hits 60 req/hr unauthenticated limit
- Handling: Cache last known value in `stats.ts` as fallback. If API fails, use cached value. Log warning in build output.

**EC2: JavaScript disabled**
- Scenario: Visitor has JS disabled — React islands (copy button, terminal, theme toggle) don't hydrate
- Handling: Copy button hidden, `<pre>` block remains selectable. Terminal shows static final state. Theme defaults to dark, no toggle.

**EC3: Mobile viewing**
- Scenario: Page shared on Slack/Twitter, opened on phone
- Handling: Responsive single-column layout at <768px. Feature grid stacks. Comparison table horizontally scrollable. Terminal demo scales down. Nav collapses to hamburger.

**EC4: Stale marketing numbers**
- Scenario: Tool 40 added but `stats.ts` still says 39
- Handling: Single source of truth in `stats.ts`. Add a comment: "Update when tools change." Future: CI check that compares against actual tool registration count.

**EC5: Clipboard API unavailable**
- Scenario: HTTP context (local dev) or old browser
- Handling: Copy button hidden via feature detection. `<pre>` block always text-selectable as fallback. No error shown.

**EC6: OG image missing or broken**
- Scenario: Social share shows no preview image
- Handling: Static `og-image.png` in `/public/`. No runtime generation. Verify with Facebook Sharing Debugger and Twitter Card Validator before launch.

**EC7: Features requiring optional setup presented as core**
- Scenario: Developer installs expecting semantic search + LSP but they require env vars / language servers
- Handling: Feature cards for semantic search and LSP display a small "requires setup" badge. How It Works section mentions the optional step.

## Acceptance Criteria

### Must have

1. Page loads at `https://codesift.app` with HTTP 200 and LCP < 2.5s on throttled 4G.
2. Hero section displays "Code intelligence for AI agents" headline, subhead with "33% fewer tokens", and `npm install -g codesift-mcp` in a copyable code block.
3. Copy-to-clipboard works on Chrome 120+, Firefox 120+, Safari 17+ over HTTPS.
4. Feature grid presents 5-6 tool categories with icons and descriptions.
5. Benchmarks section displays at least 4 proof points as large-format numbers.
6. How It Works section shows 3 steps with Shiki-highlighted code blocks.
7. Comparison table shows CodeSift vs traditional tools with checkmarks.
8. Page is fully readable with JavaScript disabled — all content visible in static HTML.
9. `<title>` contains "CodeSift" + descriptive phrase.
10. `<meta name="description">` present and under 160 characters.
11. Responsive: single-column on mobile (320px+), full layout on desktop (1024px+).
12. All images have `alt` attributes. Color contrast meets WCAG 2.1 AA.
13. `robots.txt` and `sitemap.xml` present at root.
14. 404 page exists with link back to homepage.

### Should have

1. Open Graph tags: `og:title`, `og:description`, `og:image`, `og:url`.
2. Twitter Card meta tags.
3. JSON-LD `SoftwareApplication` structured data.
4. Dark/light mode toggle, defaulting to dark. Preference persisted in `localStorage`.
5. GitHub star count displayed in social proof bar (fetched at build time).
6. Scroll-triggered fade-in animations on feature cards (CSS-only, respects `prefers-reduced-motion`).
7. Pricing teaser section displays "Free to start" text, a "Pro coming soon" label, and at least 3 listed premium features (semantic search, unlimited repos, analysis suite).
8. `<link rel="canonical">` on all pages.
9. Footer with GitHub, npm, license, and privacy policy links.

### Edge case handling

1. If GitHub API fails at build time, page builds successfully with cached star count from `stats.ts`.
2. If Clipboard API unavailable, copy button hidden; `<pre>` remains selectable.
3. If JS disabled, all content visible; interactive elements degrade to static state.
4. All external links open in new tab with `rel="noopener noreferrer"`.
5. Features requiring optional setup (semantic search, LSP) marked with "requires setup" badge.
6. Core Web Vitals: LCP < 2.5s, CLS < 0.1, INP < 200ms.

## Out of Scope

- **Stripe integration / payment processing** — pricing teaser only, no checkout flow
- **Blog / changelog** — future addition, not v1
- **Documentation site** (`docs.codesift.app`) — separate project
- **Dashboard embedding** — landing page links to dashboard, does not embed it
- **User accounts / login** — no auth on the marketing site
- **Analytics** — added post-launch (self-hosted Plausible)
- **i18n / multilingual** — English only
- **License change implementation** — separate task, landing page references the result
- **npm publish / GitHub public** — prerequisites, not part of this spec
- **Email waitlist / newsletter** — can be added later but not in v1
- **Cookie consent banner** — not needed without analytics

## Open Questions

1. **Canonical GitHub URL** — `package.json` says `github.com/greglas/codesift-mcp`, README says `github.com/greglas75/codesift.git`. Must be resolved before any CTA links are set. Affects: `stats.ts` (GitHub API fetch), `Footer.astro`, `Hero.astro` (GitHub CTA), `HowItWorks.astro` (clone URL). **Blocker for launch.**
2. **npm package name confirmation** — Hero CTA uses `npm install -g codesift-mcp`. Confirm this is the intended published package name. npm publish is a prerequisite — the hero install command must not go live before the package is available on npm. **Blocker for launch.**
3. **Exact commercial license** — BSL? PolyForm? Dual-license? Affects the "Free for personal use" copy and license link. **Blocker for launch**, but landing page can deploy with placeholder text and update when decided.
4. **Logo / brand assets** — dashboard has a text logo in SVG. Is this sufficient for the landing page or does a proper logomark need to be designed? **Not a blocker** — text logo works for v1.
