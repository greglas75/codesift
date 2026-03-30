# Use Case: Code Quality Mining at Scale

> Scan 45 repositories for known anti-patterns — then mine for new ones nobody thought to look for. 22 patterns found. 14 known, 8 discovered. 5 false positives rejected.

---

## The Problem

Code quality degrades silently. A `catch (error) {}` here, an `as any` there, an `expect(x).toBeDefined()` that proves nothing. Multiply by dozens of repositories and years of organic growth — you have thousands of hidden issues that no code review will ever catch retroactively.

**Manual approach:** grep through files, count patterns, cross-reference, build a spreadsheet. A senior engineer's full day — for one repo.

**The real cost:** You don't do it. The patterns compound until a production incident forces you to look.

---

## The CodeSift Workflow

Three tools. Parallel scans. Real numbers from a 45-repository TypeScript/NestJS/Next.js portfolio.

### Step 1: Clone Detection (AST-aware)

```
find_clones(repo, include_tests=true, min_similarity=0.6)
```

Normalized AST comparison — not regex. Finds copy-pasted helpers even when variable names differ.

### Step 2: Built-in Anti-Pattern Scan

```
search_patterns(repo, "empty-catch")
```

9 structural patterns out of the box: `empty-catch`, `any-type`, `await-in-loop`, `toctou`, `unbounded-findmany`, and more.

### Step 3: Custom Frequency Mining

```
search_text(repo, regex, file_pattern, group_by_file=true)
```

The key feature: `group_by_file` returns `{file, count, lines[]}` instead of raw matches. One call gives you frequency distribution across the entire codebase.

---

## Results: Production Code (45 repos)

### P1: Untyped catch — `catch (error)` without `instanceof Error` narrowing

The most pervasive pattern. Nearly every repo with catch blocks uses `catch (error)` without narrowing via `instanceof Error` before accessing `.message`. Crashes when third-party libs throw strings or rejected promise values.

| Metric | Value |
|--------|-------|
| **Files** | **319** |
| **Repos** | 14 of 45 |
| **Worst** | Rewards-API (80), Shield (69), translation-qa (45), tgm-survey-platform (43), promptvault (29), Offer Module (26), Inovoicer (10), country-data (6) |

```typescript
// organization.service.ts:170 — tgm-survey-platform
// Passes untyped error to handler — crashes if non-Error thrown
} catch (error) {
  this.handlePrismaUpdateError(error, id, 'update');
}
```

```typescript
// src/app/api/v1/workspaces/route.ts:104 — promptvault
// Systemic: every API route handler uses catch (error) without instanceof
} catch (error) {
  // direct use of error without narrowing
}
```

**Fix:** `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`

---

### P2: `as any` type bypass in production

Type safety defeated at the boundary. Downstream code assumes types that were never validated.

| Metric | Value |
|--------|-------|
| **Files** | **249** |
| **Repos** | 15 of 45 |
| **Worst** | Shield (98), Offer Module (52), Rewards-API (32), rs-admin (22), tgm-survey-platform (14), translation-qa (11), Inovoicer (3), country-data (2) |

```typescript
// xlsx-exporter.ts:114 — tgm-survey-platform
const streamAny = stream as any;
```

```typescript
// zustand/translation-store.ts:130 — rs-admin
// Deleting fields via as any cast instead of proper typing
delete (postData as any).translatedLanguage;
delete (postData as any).translatedCustom;
delete (postData as any).translatedToTranslate;
```

```typescript
// tours-v2/[id]/pricing/route.ts:41 — MYA
// Business-critical pricing code bypasses types
const oldValue = (updatedPricing as any)[validatedData.field] as number | null
```

**Fix:** Extend interfaces, use generics, or validate with Zod at the boundary.

---

### P3: `console.log` in production code

Raw console output instead of structured logging. No levels, no correlation IDs, invisible to monitoring.

| Metric | Value |
|--------|-------|
| **Files** | **260** |
| **Repos** | 28 of 45 |
| **Worst** | Offer Module (37), Shield (35), rs-admin (29), Rewards-API (17), Mobi 2 (16), abcweselne (12), tgm-survey-tester (10), easyAds (10), Helper (10) |

```typescript
// chatgpt.controller.ts:67 — Shield (API endpoint!)
console.log('Creating postal code prompt...')
```

```typescript
// queries/rs-result.ts:936 — rs-admin
console.log('RS Result API Call:', { ... })
```

**Fix:** Replace with structured logger. `logger.info('Creating prompt', { requestId })`

---

### P4: `JSON.parse()` without try/catch

External input parsed without error handling. Malformed JSON crashes the process.

| Metric | Value |
|--------|-------|
| **Files** | **288** |
| **Repos** | 24 of 45 |
| **Worst** | translation-qa (38), tgm-survey-platform (35), country-data (31), Offer Module (30), Rewards-API (24), coding-ui (19), MYA (18), promptvault (17), Mobi 2 (16), Shield (14), codesift-mcp (12) |

```typescript
// jwt-verify.ts:84 — Rewards-API worker
// Base64-decoded JWT payload — no try/catch
const payload = JSON.parse(atob(payloadB64));
```

```typescript
// useOrderFilters.ts:131 — Rewards-API web
// localStorage can contain anything — no try/catch
const parsed = JSON.parse(stored);
```

**Fix:** `try { data = JSON.parse(input) } catch { throw new Error('Invalid JSON') }`

---

### P5: Empty catch blocks — swallowed errors

Errors silently disappear. Failed writes return stale data. No signal to monitoring.

| Metric | Value |
|--------|-------|
| **Files** | **7** |
| **Repos** | 3 of 45 |
| **Worst** | Shield (3), Offer Module (3), translation-qa (1) |

```typescript
// survey-answer.service.ts:101 — Shield
// DB error on create silently swallowed — returns stale data
} catch (error: any) {}
```

```typescript
// content-language-table.tsx:61 — Offer Module
// Form submission error disappears
catch (error) {}
```

**Fix:** At minimum `catch (e) { logger.error('Operation failed', { error: e }) }`. Rethrow on critical paths.

---

### Production Summary

| # | Pattern | Files | Repos | Severity |
|---|---------|------:|------:|----------|
| P1 | Untyped catch | **319** | 14 | **High** |
| P2 | `as any` bypass | **249** | 15 | **High** |
| P3 | `console.log` in prod | **260** | 28 | **Medium** |
| P4 | Unsafe `JSON.parse` | **288** | 24 | **Medium** |
| P5 | Empty catch `{}` | **7** | 3 | **Critical** |

---

## Results: Test Code (45 repos, ~27 with test files)

### T1: `as any` in tests — type safety bypass

Mocks and test doubles bypass TypeScript entirely. Tests pass even when production types change.

| Metric | Value |
|--------|-------|
| **Hits** | ~1,500 |
| **Files** | ~320 |
| **Repos** | 14 |
| **Worst** | translation-qa (576), MYA (200+), AI Content Studio (181), Rewards-API (122), Offer Module (80+) |

```typescript
// context-builder.test.ts:55 — Rewards-API
// When calculateReward's signature changes, this test still passes
const result = ctx.services.reward.calculateReward({} as any, {} as any);
```

```typescript
// route.test.ts:58 — MYA
// Repeated 14 times in one file, 200+ across repo
const request = new Request(url, options) as any
```

**Why it matters:** When `calculateReward`'s signature changes, this test still passes — it's testing nothing about the contract.

---

### T2: `expect(x.length)` instead of `.toHaveLength()`

Raw `.length` access produces cryptic error messages: "expected 3 to be 5" instead of "expected array of length 3 to have length 5."

| Metric | Value |
|--------|-------|
| **Hits** | ~1,780 |
| **Files** | ~650 |
| **Repos** | 15 |
| **Worst** | translation-qa (760), tgm-survey-platform (408), AI Content Studio (117), MYA (50+), easyAds (40) |

```typescript
// qa-orchestrator.service.test.ts:63 — translation-qa
expect(result.issues.length).toBeGreaterThan(0);
expect(result.issues[0].type).toBe('error');
```

```typescript
// user-management.service.spec.ts:163 — tgm-survey-platform
expect(result.generatedPassword.length).toBe(12);
```

**Fix:** `expect(result.issues).toHaveLength(1)` — better error messages, intent is clearer.

---

### T3: `.toBeGreaterThan(0)` — vague quantity assertion

"At least one" when the test knows exactly how many to expect. Masks off-by-one bugs and duplicate insertions.

| Metric | Value |
|--------|-------|
| **Hits** | ~1,410 |
| **Files** | ~560 |
| **Repos** | 16 |
| **Worst** | translation-qa (632), tgm-survey-platform (351), Rewards-API (76), Offer Module (56), coding-ui (44) |

```typescript
// script-validation.service.spec.ts:22 — tgm-survey-platform
expect(result.success).toBe(false);
expect(result.errors.length).toBeGreaterThan(0);
```

```typescript
// runner-analytics.service.spec.ts:219 — translation-qa
expect(result.byDistanceBucket.length).toBeGreaterThan(0);
```

**Fix:** `expect(result.errors).toHaveLength(2)` — assert the exact count your fixture produces.

---

### T4: `.toBeDefined()` as sole assertion

Proves the value isn't `undefined` — nothing about its shape, content, or correctness. A renamed field still passes.

| Metric | Value |
|--------|-------|
| **Hits** | ~1,450 |
| **Files** | ~510 |
| **Repos** | 15 |
| **Worst** | translation-qa (680), tgm-survey-platform (311), MYA (80+), Rewards-API (76), coding-ui (49), easyAds (46) |

```typescript
// bot-answer-pricing-builders.test.ts:37 — tgm-survey-platform
expect(answer).not.toBeNull();
expect(answer!.structuredData).toBeDefined();
```

```typescript
// stripe.module.spec.ts:11 — tgm-survey-platform
// Tests only that the module exists, not what it does
expect(StripeModule).toBeDefined();
```

**Fix:** Assert the value: `expect(answer.structuredData).toEqual({ price: 100, currency: 'USD' })`

---

### T5: `.toBeTruthy()` / `.toBeFalsy()` — weak boolean assertion

`0`, `""`, `null`, `undefined`, and `false` all pass `.toBeFalsy()`. Doesn't distinguish between "not found" and "found but empty."

| Metric | Value |
|--------|-------|
| **Hits** | ~320 |
| **Files** | ~155 |
| **Repos** | 10 |
| **Worst** | tgm-survey-platform (113), translation-qa (101), Rewards-API (33), MYA (20), tgmresearch (16) |

```typescript
// agent-results-builder.definitions.spec.ts:20 — tgm-survey-platform
expect(definition.methodName).toBeTruthy();
expect(definition.objective).toBeTruthy();
expect(definition.interpretationSummary).toBeTruthy();
```

**Fix:** `expect(definition.methodName).toBe('calculateNPS')` — assert the actual expected value.

---

### T6: `.toEqual([])` / `.toEqual({})` — empty-state assertions

Often legitimate (testing edge cases), but 1,844 hits suggests many are lazy defaults rather than intentional boundary tests.

| Metric | Value |
|--------|-------|
| **Hits** | ~1,844 |
| **Files** | ~720 |
| **Repos** | 8 |
| **Worst** | translation-qa (760), tgm-survey-platform (649), AI Content Studio (142) |

```typescript
// mock-factories.spec.ts:152 — tgm-survey-platform
expect(req.cookies).toEqual({});
expect(req.headers).toEqual({});
expect(req.params).toEqual({});
```

---

### T7: `describe.skip` / `it.skip` — disabled tests

149 tests that never run. Some marked "enable after extraction" — from months ago.

| Metric | Value |
|--------|-------|
| **Hits** | ~149 |
| **Files** | ~70 |
| **Repos** | 5 |
| **Worst** | tgm-survey-platform (89), MYA (40+), translation-qa (11), Shield (7) |

```typescript
// seed-utils.spec.ts:443 — tgm-survey-platform
it.skip('NEG-1: seed.ts no longer defines createOptions locally', () => {
  // Enable after extraction — verify no duplicate definitions remain
```

```typescript
// feedback.service.test.ts:25 — MYA
// Entire test suite disabled — ~200 lines never run
describe.skip('FeedbackService', () => {
```

---

### T8: `expect(true).toBe(true)` — tautological assertion

Tests that always pass. Every instance was explicitly marked `// Placeholder`.

| Metric | Value |
|--------|-------|
| **Hits** | ~13 |
| **Files** | ~7 |
| **Repos** | 5 |

```typescript
// orders-query.test.ts:158 — Rewards-API
expect(true).toBe(true); // Placeholder - actual test would verify RPC uses view

// group-translation.service.test.ts:262 — translation-qa
expect(true).toBe(true); // Placeholder
```

---

### T9: Mock density — ~30,000 mocks across ~3,200 files

Not an anti-pattern by itself, but **~9.4 mocks per test file** is a signal. High mock density means tests are coupled to implementation, not behavior.

| Metric | Value |
|--------|-------|
| **Hits** | ~30,000 |
| **Files** | ~3,200 |
| **Worst** | translation-qa (11,125), tgm-survey-platform (8,271), Methodology Platform (3,552) |

```typescript
// group-translation-engines.test.ts:14 — translation-qa
vi.mock('../../lib/ai-clients');
vi.mock('../../lib/services/prompt-builder.service');
vi.mock('../../lib/services/language-pair-router.service');
vi.mock('../../lib/services/analysis/analysis-models');
```

---

### Test Code Summary

| # | Pattern | Hits | Files | Repos | Severity |
|---|---------|-----:|------:|------:|----------|
| T9 | Mock density | ~30,000 | ~3,200 | 16 | Informational |
| T6 | Empty-state `.toEqual` | ~1,844 | ~720 | 8 | Low |
| T2 | Raw `.length` access | ~1,780 | ~650 | 15 | **Medium** |
| T4 | `.toBeDefined()` only | ~1,450 | ~510 | 15 | **Medium** |
| T3 | Vague `.toBeGreaterThan(0)` | ~1,410 | ~560 | 16 | **Medium** |
| T1 | `as any` in tests | ~1,500 | ~320 | 14 | **High** |
| T5 | Weak `.toBeTruthy()` | ~320 | ~155 | 10 | **Medium** |
| T7 | Skipped tests | ~149 | ~70 | 5 | **High** |
| T8 | Tautological assert | ~13 | ~7 | 5 | **Critical** |

---

## Discovery: 8 New Anti-Patterns Found by Mining

The patterns above (P1-P5, T1-T9) came from a known checklist. The real value of frequency mining is finding patterns **nobody thought to look for**. We ran 30 exploratory regexes across the 5 biggest repos. Here's what surfaced.

### Production — 3 genuinely novel patterns

#### NEW P6: `new Date()` scattered in business logic — no clock injection

Services call `new Date()` directly. Time-dependent logic becomes untestable without mocking globals.

| Metric | Value |
|--------|-------|
| **Hits** | 200+ |
| **Repos** | 5 of 5 scanned |
| **Worst** | Offer Module (50+), translation-qa (50+), Shield (40+), Rewards-API (40+) |

```typescript
// trusted-device.service.ts — Shield
// 7 new Date() calls — can't test expiry logic without mocking
const now = new Date();
const expiresAt = new Date(now.getTime() + this.TRUST_DURATION);

// moderation-queue.service.ts — tgm-survey-platform
// 6 separate new Date() calls — non-deterministic test results
decidedAt: new Date(),
```

**Fix:** Inject a clock: `this.clock.now()` — testable, deterministic, one-line mock in tests.

---

#### NEW P7: Magic time arithmetic — inline `24 * 60 * 60 * 1000`

Unnamed numeric expressions for durations scattered in business logic. The existing "magic numbers" pattern only covers money.

| Metric | Value |
|--------|-------|
| **Hits** | 150+ |
| **Repos** | 5 of 5 scanned |

```typescript
// auth.controller.ts — Shield
// What is 15 * 24 * 60 * 60 * 1000? Nobody knows without calculating
maxAge: 15 * 24 * 60 * 60 * 1000

// content-scan.service.ts — tgm-survey-platform
const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
```

**Fix:** Named constants: `const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000` or a duration helper.

---

#### NEW P8: `dangerouslySetInnerHTML` without sanitization — confirmed XSS

Not a new concept, but mining found 10 unsanitized instances across 3 repos. Shield had **confirmed stored XSS** from this.

| Metric | Value |
|--------|-------|
| **Unsanitized** | ~10 instances |
| **Repos** | Shield (3 unsanitized), Offer Module (2), translation-qa (partial) |

```typescript
// GetStartedPage.tsx:147 — Shield (CONFIRMED XSS)
<span dangerouslySetInnerHTML={{ __html: introductionText.surveyIntroductionText }} />

// comment-card.tsx:60 — Offer Module (no DOMPurify)
dangerouslySetInnerHTML={{ __html: comment.content }}
```

---

### Tests — 5 genuinely novel patterns

#### NEW T10: Hardcoded UUIDs copy-pasted across 55+ files

The same UUID string pasted in dozens of test files instead of a factory function. When UUID validation rules change, 55+ files break.

| Metric | Value |
|--------|-------|
| **Hits** | 600+ UUID occurrences |
| **Files** | ~150 |
| **Repos** | 5 of 5 |
| **Worst** | Offer Module — same UUID `1ef8a579-...` in 55+ files |

```typescript
// Repeated in 55+ test files — Offer Module
const ownerId = "1ef8a579-9028-477c-94e7-06a61b8e99fc";
const userId = "1ef8a579-9028-477c-94e7-06a61b8e99fc";
```

**Fix:** `const MOCK_USER_ID = createMockUuid()` in a shared test factory.

---

#### NEW T11: God test files — 138 tests in a single file

Test files with >30 `it()` blocks. Maintenance nightmare — hard to find tests, slow to run in isolation, 3000+ lines.

| Metric | Value |
|--------|-------|
| **Files >30 tests** | 15 |
| **Repos** | 4 of 5 |
| **Worst** | `offer.controller.spec.ts` — **138 tests** in one file |

```
offer.controller.spec.ts       138 tests   Offer Module
script-status.dsl.spec.ts       58 tests   tgm-survey-platform
logger.module.spec.ts            40 tests   tgm-survey-platform
```

**Fix:** Split by behavior group. 138 tests → 5-6 focused files of ~25 each.

---

#### NEW T12: Mock coupling — 15+ mock return values wired per file

Files with 15+ `mockResolvedValue` / `mockReturnValue` calls. Tests coupled to implementation, not behavior. When Prisma methods are rearranged, tests break even though behavior is unchanged.

| Metric | Value |
|--------|-------|
| **Files >15 mocks** | ~300 |
| **Repos** | 5 of 5 |

```typescript
// coding-result.service.spec.ts — tgm-survey-platform (34 mock setups)
mockPrisma.response.findUnique.mockResolvedValue(null);
mockPrisma.response.findMany.mockResolvedValue([...]);
// ...30 more lines of mock wiring before any actual test
```

---

#### NEW T13: Unfrozen time — `new Date()` in test assertions without fake timers

`new Date()` or `Date.now()` used in time-delta calculations in tests without `vi.useFakeTimers()`. Fails at midnight, DST transitions, or slow CI.

| Metric | Value |
|--------|-------|
| **Real instances** | ~100 (of 400+ total `Date` usage — most are harmless fixture data) |
| **Repos** | 5 of 5 |

```typescript
// Rewards-API — time-sensitive assertion without frozen clock
const expiredDate = new Date(Date.now() - 86400000).toISOString();
const expectedExp = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
```

---

#### NEW T14: Lazy test names — "should work" / "should be" without specifying WHAT

~60 genuinely lazy names (out of 800+ "should" matches). Failure messages are useless.

| Metric | Value |
|--------|-------|
| **Genuinely lazy** | ~60 |
| **Repos** | 5 of 5 |

```typescript
// Bad — what does "work" mean?
it('should work with full realistic data', () => {

// Good — specifies the expected outcome
it('should return 400 when id is missing', async () => {
```

---

### Discovery — what was eliminated

Not everything we mined was a real pattern. Frequency analysis + code examples let us **reject false positives**:

| Candidate | Hits | Verdict | Why eliminated |
|-----------|------|---------|----------------|
| Test-to-test imports | 200+ | **Good practice** | Imports from `.test-fixtures.ts` / `.test-setup.ts` — purpose-built helpers |
| Snapshot overuse | 2 | **Non-issue** | Almost zero usage across all repos |
| `eval()` / `new Function()` | 0 | **Clean** | None found in any repo |
| Non-null `!.` in prod | ~10 | **Low signal** | Almost all in tests (acceptable); only tgm Stripe service in prod |
| `.sort()` mutation | ~15 | **Partial** | Most use `[...arr].sort()` (safe); only Shield has real `.splice()` on params |

### Discovery summary

| # | Pattern | Hits | Novel? | Severity |
|---|---------|------|--------|----------|
| P6 | `new Date()` no clock | 200+ | **Yes** | High |
| P7 | Magic time arithmetic | 150+ | **Yes** | Medium |
| P8 | Unsanitized innerHTML | ~10 | Confirmed | Critical |
| T10 | Hardcoded UUIDs | 600+ | **Yes** | High |
| T11 | God test files (>30 tests) | 15 files | **Yes** | High |
| T12 | Mock coupling (>15 mocks/file) | 300+ files | **Yes** | Medium |
| T13 | Unfrozen time in tests | ~100 | **Yes** | Medium |
| T14 | Lazy test names | ~60 | **Yes** | Low |

**6 of 8 patterns were genuinely novel** — not in any existing catalog. Found by running 30 exploratory regexes and triaging results by frequency + code review.

---

## The Full Picture

### Combined heatmap — which repos need attention?

| Repo | Prod Files | Test Hits | Worst Pattern | Priority |
|------|:----------:|:---------:|---------------|----------|
| **Shield** | 205 | 7 skip | empty catch in DB writes | Prod first |
| **Offer Module** | 148 | 80+ `as any`, 56 >0 | 3 empty catches + 52 `as any` | Both layers |
| **Rewards-API** | 153 | 122 `as any`, tautological | untyped catch (80 files) | Both layers |
| **tgm-survey-platform** | 100 | 8,271 mocks, 89 skip | 311 toBeDefined in tests | Both layers |
| **translation-qa** | 94 | 11,125 mocks, 680 toBeDefined | test layer volume | Test layer |
| **MYA** | 18 | 200+ `as any`, 40+ skip | `as any` in pricing routes | Both layers |
| **promptvault** | 65 | minimal | 29 untyped catch (one wrapper fix) | Prod |
| **rs-admin** | 56 | minimal | 29 console.log + 22 `as any` | Prod |
| **country-data** | 40 | 15 `.length` | 31 JSON.parse without try/catch | Prod |
| **coding-ui** | 19 | 49 toBeDefined, 37 `as any` | test layer | Test layer |
| **Inovoicer** | 21 | 36 `as any`, 100+ mocks | 10 untyped catch in auth | Prod |
| **AI Content Studio** | low | 181 `as any`, 117 `.length` | test layer | Test layer |
| **codesift-mcp** | near-zero | 2 tautological (known) | — | Clean |
| **codesift-dashboard** | near-zero | clean | — | Clean |

### Repos with zero issues (18 repos)

Mobi 2 (minimal), Prefetch, wczasywazji-portal, wczasywazji, abcmaroko, abctajlandia, abcweselne, TGM Panel website, Helper, videogen, videogen2, videogen3, traveliger, zyczeniakartki, wycieczki-wczasywazji-cms, wycieczki.wczasywazji.pl, MakeYourAsia, zuvo-plugin.

---

## How the Scan Ran

### Phase 1: Known pattern scan (45 repos)

| Step | Tool | Calls | Purpose |
|------|------|------:|---------|
| Clone detection | `find_clones` | 1 | AST-aware copy-paste detection |
| Built-in patterns | `search_patterns` | ~90 | `empty-catch`, `no-error-type` x 45 repos |
| Known regex mining | `search_text(group_by_file)` | ~380 | 14 patterns x repos with code |
| Code examples | `search_text(context_lines)` | ~20 | Real snippets for worst offenders |
| **Subtotal** | | **~490 calls** | **4 parallel agents, ~8 min** |

### Phase 2: Discovery (top 5 repos, 30 exploratory regexes)

| Step | Tool | Calls | Purpose |
|------|------|------:|---------|
| Novel prod patterns | `search_text(group_by_file)` | ~85 | 15 regexes x 5 repos |
| Novel test patterns | `search_text(group_by_file)` | ~85 | 15 regexes x 5 repos |
| Triage examples | `search_text(context_lines)` | ~30 | Code review for real vs noise |
| **Subtotal** | | **~200 calls** | **2 parallel agents, ~6 min** |

### Total

| | Known Patterns | Discovery | Combined |
|---|:-:|:-:|:-:|
| Repos scanned | 45 | 5 (deepest) | 45 |
| Tool calls | ~490 | ~200 | **~690** |
| Wall time | ~8 min | ~6 min | **~14 min** |
| Patterns found | 14 (P1-P5, T1-T9) | 8 new (P6-P8, T10-T14) | **22** |
| False positives rejected | — | 5 (test imports, snapshots, eval, `!.`, `.sort()`) | 5 |

The same analysis manually: **1-2 weeks** for a senior engineer covering 45 repos. And they'd miss the cross-repo frequency comparison and discovery phase entirely.

---

## Why This Matters

### What CodeSift gives you that grep can't

1. **AST-aware clone detection** — finds duplicated helpers even with renamed variables
2. **`group_by_file` aggregation** — frequency distribution in one call, not post-processing
3. **Structural patterns** — `search_patterns` understands code structure, not just text
4. **Cross-repo comparison** — same query across 45 repos, unified frequency table
5. **Batch queries** — `codebase_retrieval` runs multiple searches in a single call
6. **Parallel agent scans** — 6 agents across 2 phases, 14 minutes total
7. **Discovery + triage** — mine with exploratory regexes, then review code examples to separate real patterns from noise (5 of 13 candidates were rejected)

### The business impact

- **Fewer false-green tests** — 1,450 `.toBeDefined()` assertions that prove nothing get flagged
- **Production risk visibility** — 319 files with untyped catch, 7 with swallowed errors, 249 with `as any`
- **Targeted refactoring** — Shield needs prod cleanup, translation-qa needs test cleanup, Offer Module needs both
- **Pattern catalog growth** — this scan added 8 new patterns (P6-P8, T10-T14) to the catalog that no prior review had found
- **False positive filtering** — 5 of 13 discovery candidates were rejected with evidence (test-to-test imports = good practice, eval = zero hits, etc.)
- **Onboarding** — new devs see "don't do this" backed by frequency data from their own codebase
- **Regression tracking** — re-run monthly, compare frequency trends across sprints

---

## Integration with AI Agents

This workflow is designed for AI-assisted development. An agent (Claude Code, Cursor, etc.) with CodeSift MCP can:

1. **Run the full scan autonomously** — parallel agents, each scanning a group of repos
2. **Rank findings by severity and frequency** — not just "found X", but "found X in 1,450 places across 510 files in 15 repos"
3. **Generate fix PRs** — the agent knows which files to touch, what the fix looks like, and can batch similar fixes
4. **Track regression** — re-run monthly, diff against previous scan

The agent doesn't need to read every file. CodeSift's indexed search + `group_by_file` gives it the overview. It only reads specific files when it needs to fix something.

---

## Try It

```bash
npm install -g codesift-mcp
codesift index .
```

Then ask your AI agent:

> "Scan all my repos for code quality anti-patterns. Split production vs test findings. Show TOP 10 by frequency with code examples."

The agent will use `find_clones`, `search_patterns`, and `search_text(group_by_file=true)` — exactly the workflow documented here.
