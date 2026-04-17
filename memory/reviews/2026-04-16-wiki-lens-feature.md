# Code Review: Wiki + Lens Feature

**Date:** 2026-04-16
**Scope:** 527f46c~1..0cd9862 (13 commits)
**Tier:** 3 — DEEP
**Verdict:** CONDITIONAL PASS
**Risk:** HIGH (6 points)

## Meta

- 27 files changed, +3204/-2 lines
- 16 production files, 11 test files
- 154 tests — all passing
- Adversarial: cursor-agent (2 passes)

## Findings

### MUST-FIX

**R-1 [MUST-FIX] Wiki context injection broken — .summary.md files never generated**
File: src/tools/wiki-tools.ts (orchestrator) + src/cli/hooks.ts:199
Confidence: 95/100
Evidence: `generateCommunitySummary` defined at wiki-page-generators.ts:75 but never called by `generateWiki`. Hook at hooks.ts:199 reads `${slug}.summary.md` files that never get written. Spec (docs/specs/2026-04-15-wiki-lens-spec.md:56) requires pre-generated summary files. Feature is half-wired.
Fix: Call `generateCommunitySummary()` in `generateWiki` and write `{slug}.summary.md` files alongside community pages.

### RECOMMENDED

**R-2 [RECOMMENDED] [CROSS:cursor-agent] include_lens parameter accepted but never used**
File: src/register-tools.ts:1924 (schema) vs :1928 (handler)
Confidence: 92/100
Evidence: Schema defines `include_lens: z.boolean().optional()` but handler never reads `args.include_lens`.
Fix: Wire through to `generateWiki` or remove from schema until implemented.

**R-3 [RECOMMENDED] [CROSS:cursor-agent] --current-hash CLI flag documented but not wired**
File: src/cli/help.ts + src/cli/wiki-commands.ts:41
Confidence: 92/100
Evidence: Help text says `[--current-hash <hash>]` but `handleWikiLint` ignores `_flags`.
Fix: Wire `getFlag(flags, "current-hash")` into `lintWiki(wikiDir, hash)`.

**R-4 [RECOMMENDED] [CROSS:cursor-agent] --trim CLI flag documented but not wired**
File: src/cli/help.ts
Confidence: 92/100
Evidence: Help says `[--trim]` but `handleWikiGenerate` doesn't read it.
Fix: Wire or remove from help until implemented.

**R-5 [RECOMMENDED] [CROSS:cursor-agent] CDN scripts without Subresource Integrity**
File: src/tools/lens-template.ts:378-379
Confidence: 80/100
Evidence: `<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js">` and marked loaded without `integrity` or `crossorigin` attributes.
Fix: Add `integrity="sha384-..."` + `crossorigin="anonymous"`, or vendor the scripts.

**R-6 [RECOMMENDED] Defense-in-depth: validate communitySlug before path.join (when R-1 is fixed)**
File: src/cli/hooks.ts:199
Confidence: 75/100
Evidence: `communitySlug` from parsed JSON used in `join(repoRoot, ".codesift", "wiki", ...)` without validation. Though `toSlug()` ensures safe output, the reader doesn't verify slug format.
Fix: Add `if (!/^[a-z0-9-]+$/.test(communitySlug)) return null;` before path construction.

**R-7 [RECOMMENDED] marked.parse without HTML sanitization option**
File: src/tools/lens-template.ts:218
Confidence: 60/100
Evidence: `marked.parse(page.content)` renders markdown to HTML via `innerHTML`. `escMd` escapes `<` to `\<` but CommonMark backslash escapes produce literal chars that could form HTML tags.
Fix: Configure marked with `{ breaks: true }` and a sanitizer, or use `DOMPurify.sanitize()` on output.

**R-8 [RECOMMENDED] generateWiki function exceeds size limit (265L)**
File: src/tools/wiki-tools.ts:97-362
Confidence: 85/100
Evidence: Public function limit is 50L. `generateWiki` is 265L (5x limit). CQ11=0.
Fix: Extract analysis unwrapping into helper functions (e.g., `unwrapCommunities`, `unwrapRoles`).

**R-9 [RECOMMENDED] Vague test assertions — exact counts known but not asserted**
File: tests/tools/wiki-tools.test.ts:230-233
Confidence: 80/100
Evidence: `expect(result.pages).toBeGreaterThan(0)` and `expect(result.hubs).toBeGreaterThanOrEqual(0)` where fixture data produces known exact counts. AP27 violation, Q15/Q17 critical gate failure.
Fix: Assert exact values: `expect(result.pages).toBe(6)`, `expect(result.hubs).toBe(1)`.

### NITs

R-10: Duplicate `toSlug` in wiki-tools.ts:73 and wiki-manifest.ts:32. Extract to shared util.
R-11: Unnecessary cast `as { message: string }` in wiki-commands.ts:50 — `LintIssue` already has `message`.
R-12: Windows path separator mismatch in hooks.ts `tryLoadWikiSummary` — `relative()` returns backslashes on Windows but manifest keys use forward slashes.

## CQ Evaluations

### wiki-tools.ts (ORCHESTRATOR)

```
CQ EVAL: wiki-tools.ts (362L) | CQ1=1 CQ2=1 CQ3=N/A CQ4=N/A CQ5=N/A CQ6=1 CQ7=N/A CQ8=1 CQ9=N/A CQ10=1 CQ11=0 CQ12=1 CQ13=1 CQ14=1 CQ15=1 CQ16=N/A CQ17=1 CQ18=N/A CQ19=N/A CQ20=N/A CQ21=1 CQ22=N/A CQ23=N/A CQ24=N/A CQ25=1 CQ26=N/A CQ27=N/A CQ28=1 | Score: 14/15 -> CONDITIONAL PASS | Critical gates: CQ6=1 CQ8=1 CQ14=1 -> PASS
```

### lens-template.ts (TEMPLATE)

```
CQ EVAL: lens-template.ts (394L) | CQ1=1 CQ2=1 CQ3=N/A CQ4=N/A CQ5=1 CQ6=1 CQ7=N/A CQ8=N/A CQ9=N/A CQ10=1 CQ11=1 CQ12=1 CQ13=1 CQ14=1 CQ15=N/A CQ16=N/A CQ17=N/A CQ18=N/A CQ19=N/A CQ20=N/A CQ21=N/A CQ22=N/A CQ23=N/A CQ24=N/A CQ25=1 CQ26=N/A CQ27=N/A CQ28=N/A | Score: 10/10 -> PASS | Critical gates: CQ5=1 CQ6=1 CQ14=1 -> PASS
```

### wiki-surprise.ts (PURE)

```
CQ EVAL: wiki-surprise.ts (129L) | CQ1=1 CQ2=1 CQ3=N/A CQ4=N/A CQ5=N/A CQ6=1 CQ7=N/A CQ8=N/A CQ9=N/A CQ10=1 CQ11=0 CQ12=1 CQ13=1 CQ14=1 CQ15=N/A CQ16=N/A CQ17=N/A CQ18=N/A CQ19=N/A CQ20=N/A CQ21=N/A CQ22=N/A CQ23=N/A CQ24=N/A CQ25=1 CQ26=N/A CQ27=N/A CQ28=N/A | Score: 8/9 -> CONDITIONAL PASS | Critical gates: CQ6=1 CQ14=1 -> PASS
```

### Other files (small, pure utilities)

All remaining production files (wiki-escape, wiki-links, wiki-lint, wiki-manifest, wiki-page-generators, lens-tools, wiki-commands, hooks additions, register-tools additions) — PASS with no critical gate failures.

## Q Evaluations

### wiki-tools.test.ts

```
Q EVAL: wiki-tools.test.ts | Q1=1 Q2=1 Q3=0 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=0 Q12=0 Q13=1 Q14=1 Q15=0 Q16=1 Q17=0 Q18=1 Q19=1 | Score: 14/19 -> FIX | Critical: Q7=1 Q11=0 Q13=1 Q15=0 Q17=0 -> FAIL
```

### wiki-surprise.test.ts

```
Q EVAL: wiki-surprise.test.ts | Q1=1 Q2=1 Q3=1 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | Score: 19/19 -> PASS | Critical: all PASS
```

### wiki-page-generators.test.ts

```
Q EVAL: wiki-page-generators.test.ts | Q1=1 Q2=1 Q3=1 Q4=0 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=0 Q12=0 Q13=1 Q14=1 Q15=0 Q16=1 Q17=0 Q18=1 Q19=1 | Score: 14/19 -> FIX | Critical: Q11=0 Q15=0 Q17=0 -> FAIL
```

### wiki-escape.test.ts, wiki-links.test.ts, wiki-lint.test.ts, wiki-manifest.test.ts

All PASS (19/19 or 18/19+).

## Quality Wins

1. **Graceful degradation architecture** — each analysis wrapped in Promise.allSettled + withTimeout. Any failure produces degraded output, never crashes. Excellent CQ8 compliance.
2. **Atomic manifest write** — write-to-tmp + rename prevents corrupt manifest on crash. Lockfile prevents concurrent generation.
3. **Comprehensive escape utilities** — separate `escMd` and `escHtml` with clear documentation. Both tested with edge cases.

## Deployment Risk

| Factor | Points |
|--------|--------|
| API contract changes (new MCP tool) | +2 |
| File in churn hotspot (register-tools.ts #1) | +2 |
| >500 lines changed | +1 |
| New production files added (9) | +1 |
| **Total** | **6 → HIGH** |

Strategy: Canary recommended — deploy to subset first.

## Skipped Steps

- Multi-pass (--thorough) not requested
- Dead code scan (knip) not available

## Adversarial Summary

2 sequential passes (cursor-agent). 14 findings total, 7 per pass. Key confirmed findings: dead include_lens param (R-2), unwired CLI flags (R-3, R-4), CDN without SRI (R-5), path traversal defense-in-depth (R-6). Cross-provider confirmed 5 of 12 internal findings.
