# Code Review: Wiki/Lens 12-Findings Fix Commit

**Date:** 2026-04-17
**Scope:** HEAD~1..HEAD = 56d2a2a "fix: address 12 review findings across wiki/lens feature"
**Tier:** 2 — STANDARD
**Verdict:** CONDITIONAL PASS
**Risk:** MEDIUM (2 points — API contract change: include_lens removed from MCP schema)

## Meta

- 10 code files changed, +102/-112 lines (excluding memory/)
- 7 production files, 3 test files
- 65/65 tests passing in affected suites
- Adversarial: codex-5.3 (pass 1), cursor-agent (pass 2)

## Prior findings verification

| Prior | Status | Notes |
|-------|--------|-------|
| R-1 MUST-FIX (.summary.md never generated) | ✅ Fixed | `generateCommunitySummary` wired; files written; added to newFiles set to survive cleanup |
| R-2 include_lens unused | ✅ Fixed | Removed from schema |
| R-3 --current-hash not wired | ✅ Fixed | `getFlag(flags, "current-hash")` wired to lintWiki |
| R-4 --trim not wired | ✅ Fixed | Removed from help |
| R-5 SRI missing | ⚠ Partial | Added crossorigin + pinned versions, but `integrity=` still absent → re-reported as R-4 |
| R-6 slug path validation | ✅ Fixed | Regex check added in hooks.ts |
| R-7 XSS sanitizer | ⚠ Partial | Strips 5 tag types only; event handlers + `javascript:` URLs still pass → re-reported as R-1 (MUST-FIX) |
| R-8 generateWiki 265L | ⚠ Partial | Reduced to 231L via `unwrapSettled` helper; still 4.6× over 50L cap |
| R-9 vague test assertions | ✅ Fixed | `toBe(6)`, `toBe(1)`, `toBe(0)` |
| R-10 duplicate toSlug | ✅ Fixed | Exported from wiki-manifest, imported in wiki-tools |
| R-11 unnecessary cast | ✅ Fixed | Removed (LintIssue.message is statically typed) |
| R-12 Windows path | ✅ Fixed | `.split("\\").join("/")` normalization |

## New findings

### MUST-FIX

**R-1 [MUST-FIX] [CROSS:codex-5.3,cursor-agent] Lens markdown sanitizer bypassable (XSS)**
- File: `src/tools/lens-template.ts:220-224`
- Confidence: 100 (adversarial CRITICAL bypass)
- Strips only `<script,iframe,object,embed,form>`. Leaves `onerror`/`onclick`/`onload` handlers, `javascript:` URLs, `<svg onload=...>` intact. `<img src=x onerror=alert(1)>` fires via `innerHTML`.
- Fix: vendor DOMPurify OR render via `textContent` only.

**R-2 [MUST-FIX] [CROSS:cursor-agent] unwrapSettled extractor has no try/catch**
- File: `src/tools/wiki-tools.ts:81-92`
- Confidence: 85
- Malformed-but-fulfilled analyzer payload throws → generateWiki aborts instead of degrading. Defeats the very contract the helper was extracted to formalize.
- Fix: wrap `extractor(...)` call in try/catch, push `${label}_parse_error` to degradedReasons on failure.

### RECOMMENDED

**R-3 [RECOMMENDED] [CROSS:codex-5.3,cursor-agent] toSlug collisions silently overwrite summaries**
- File: `src/tools/wiki-manifest.ts:32` + loop at `wiki-tools.ts:215-232`
- Confidence: 80
- `Auth/API` and `Auth API` both → `auth-api`. Second community's page + summary overwrites first's. `communities.find((c) => toSlug(c.name) === comm.slug)` returns first match only.
- Fix: track seen slugs in `buildWikiManifest`, suffix collisions with `-2`, `-3`, or short hash.

**R-4 [RECOMMENDED] [CROSS:codex-5.3] Prior SRI fix incomplete — integrity attribute missing**
- File: `src/tools/lens-template.ts:384-385`
- Confidence: 85
- `crossorigin="anonymous"` enables SRI mode but without `integrity="sha384-..."` no hash check occurs.
- Fix: compute SHA-384 hashes or vendor the bundles locally.

### NITs

- R-5: `rendered.textContent = '';` at lens-template.ts:219 is dead (overwritten 4 lines later).
- R-6: hooks.ts path normalization handles `\` but not UNC / case-insensitive FS variants.

## Dropped findings

- handleWikiLint `.message` access without narrowing — LintIssue.message is statically typed (false positive from cursor-agent).
- include_lens schema drift — noLens IS wired in wiki-commands.ts:12; only MCP schema field removed, help text unchanged (false positive).
- degradedReasons leak — speculative, below confidence gate.

## Verification

- Tests: 3 affected suites (wiki-tools, wiki-commands, register-tools) — 65/65 passing
- Type check: not run separately (tests compile under vitest)

## Deployment

- Risk: MEDIUM
- Strategy: merge after full test suite; MCP schema change for `include_lens` removal is a minor breaking change for any clients that passed it (zod strips unknown keys by default, so behavior is graceful, but advertise the removal).
