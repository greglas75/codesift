# Implementation Plan: Python Security Capabilities

**Spec:** inline — derived from pentest review and CodeSift gap analysis
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 10
**Estimated complexity:** 5 standard + 5 complex

## Architecture Summary

This plan extends the existing Python work after:
- `docs/specs/2026-04-11-python-foundation-plan.md`
- `docs/specs/2026-04-11-python-phase-2-4-plan.md`

The new work adds a security layer on top of the Python parser, symbol index, route tracing, and wiring tools. The goal is to answer common pentest questions without forcing agents into repeated `search_text` + manual trace chains.

Primary module boundaries:
- **Search ergonomics:** extend `search_symbols` with decorator-aware filtering
- **Security primitives:** add constant resolution and Django effective access/security resolution
- **Data-flow layer:** new Python taint engine for source → sink traces
- **Security compounds:** build higher-level Python/Django security scans on top of taint + patterns
- **Regression safety:** add fixtures based on real Sentry-style findings and known false positives

## Technical Decisions

- Reuse the existing Python decorator metadata already emitted by the extractor. Do not re-parse decorators in search.
- Ship security capabilities in layers:
  1. search/filter ergonomics
  2. security primitives
  3. taint tracing MVP
  4. compound tools and presets
- Treat taint tracing as heuristic-first. v1 does not require SSA, alias analysis, or full interprocedural precision.
- Keep new security tools Python-focused first, with Django presets and partial Flask/FastAPI support where already easy to inherit.
- Add regression fixtures for both true positives and false positives. Security tooling without negative fixtures will drift into alert spam.

## Quality Strategy

- Every new capability must have at least one positive and one negative test.
- Sentry-derived false positives are first-class regression cases, not “nice to have”.
- New tools must emit structured locations (`file`, `line`, optional `symbol`) instead of opaque `path:line` strings.
- Compound scans must return a heuristic/confidence explanation whenever the result is not parser-certain.

## Task Breakdown

### Task 1: Decorator-aware symbol filtering
**Files:** `src/tools/search-tools.ts`, `src/register-tools.ts`, `src/cli/commands.ts`, `src/storage/usage-tracker.ts`, `src/instructions.ts`, `tests/integration/python-search-tools.test.ts`
**Complexity:** standard
**Dependencies:** Python foundation complete enough to index decorator metadata

- [ ] RED: Add integration tests covering bare decorator filters (`login_required`), full decorator filters (`@dataclass`), and decorator calls with args (`router.get`).
- [ ] GREEN: Extend `search_symbols` with optional `decorator` filter using existing `CodeSymbol.decorators` metadata. Match both exact decorators and decorator calls like `@router.get("/x")`.
- [ ] Verify: `npx vitest run tests/integration/python-search-tools.test.ts tests/integration/tools.test.ts`
- [ ] Commit: `add decorator-aware filtering to search_symbols`

### Task 2: Constant and literal resolver
**Files:** `src/tools/python-constants-tools.ts` (new), `src/register-tools.ts`, `tests/tools/python-constants-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1

- [ ] RED: Add tests for module constants, simple aliases, default arg literals, and negative cases where values are computed dynamically.
- [ ] GREEN: Implement `resolve_constant_value(repo, symbol_name, options)` to resolve literals and simple constant propagation across files for Python.
- [ ] Verify: `npx vitest run tests/tools/python-constants-tools.test.ts`
- [ ] Commit: `add Python constant resolution tool`

### Task 3: Django effective view security resolver
**Files:** `src/tools/django-view-security-tools.ts` (new), `src/tools/wiring-tools.ts`, `src/register-tools.ts`, `tests/tools/django-view-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Python phase 2-4 wiring work

- [ ] RED: Add tests for function views, class views, `login_required`, `csrf_exempt`, middleware-required cases, and missing-protection cases.
- [ ] GREEN: Implement `effective_django_view_security(repo, path|symbol, options)` to combine decorators, middleware, and view metadata into one effective security posture.
- [ ] Verify: `npx vitest run tests/tools/django-view-security-tools.test.ts`
- [ ] Commit: `add effective Django view security resolver`

### Task 4: Python taint trace MVP
**Files:** `src/tools/taint-tools.ts` (new), `src/register-tools.ts`, `src/formatters.ts`, `tests/tools/taint-tools.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 1-3

- [ ] RED: Add tests for request input reaching SQL, HTML, redirect, subprocess, and path sinks through local variables and simple helper calls.
- [ ] GREEN: Implement `taint_trace(repo, options)` with Python source presets, sink presets, and heuristic propagation within a function and through simple same-repo calls.
- [ ] Verify: `npx vitest run tests/tools/taint-tools.test.ts`
- [ ] Commit: `add Python taint trace MVP`

### Task 5: Framework source/sink presets
**Files:** `src/tools/taint-tools.ts`, `src/tools/python-security-presets.ts` (new), `tests/tools/taint-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 4

- [ ] RED: Add tests that Django, Flask, and FastAPI presets expand to the expected source and sink sets.
- [ ] GREEN: Add framework presets for Django request objects, Flask request/input patterns, and FastAPI request/body/query sources plus common sink bundles.
- [ ] Verify: `npx vitest run tests/tools/taint-tools.test.ts`
- [ ] Commit: `add Python framework security presets for taint tracing`

### Task 6: Python security scan compound tool
**Files:** `src/tools/python-security-tools.ts` (new), `src/register-tools.ts`, `src/formatters.ts`, `tests/tools/python-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 3-5

- [ ] RED: Add tests for mixed results across XSS, SQL, redirect, SSRF, path traversal, and replay-token style issues.
- [ ] GREEN: Implement `python_security_scan(repo, options)` that composes route tracing, effective view security, constants, patterns, and taint traces into one result set.
- [ ] Verify: `npx vitest run tests/tools/python-security-tools.test.ts`
- [ ] Commit: `add compound Python security scan tool`

### Task 7: Expand built-in Python security patterns
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools-python.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Add positive/negative tests for `mark-safe-user-input`, `open-redirect-builder`, `requests-no-timeout`, `path-traversal-join`, `xml-unsafe-parse`, and related patterns.
- [ ] GREEN: Extend `search_patterns` with missing Python/Django security patterns discovered during the pentest analysis.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools-python.test.ts`
- [ ] Commit: `expand Python security patterns for common pentest sinks`

### Task 8: Sentry-style regression fixtures
**Files:** `tests/fixtures/python-security/` (new), `tests/integration/python-security-smoke.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 1-7

- [ ] RED: Add fixtures covering optional OAuth state, shared session key clobber, replayable verification link, missing org validation, and the known false positive around scoped group lookup.
- [ ] GREEN: Convert those cases into repeatable end-to-end integration tests using real indexing and tool calls.
- [ ] Verify: `npx vitest run tests/integration/python-security-smoke.test.ts`
- [ ] Commit: `add Sentry-derived Python security regression fixtures`

### Task 9: Documentation and agent guidance refresh
**Files:** `README.md`, `CLAUDE.md`, `src/instructions.ts`, `rules/codesift.md`
**Complexity:** standard
**Dependencies:** Tasks 1-8

- [ ] RED: Update instruction tests if tool guidance or counts change.
- [ ] GREEN: Document the actual Python security workflow: `trace_route` → `effective_django_view_security` → `taint_trace` → `python_security_scan`.
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
- [ ] Commit: `document Python security workflow and tool guidance`

### Task 10: Benchmark and release gate
**Files:** `benchmarks/` (new or extend), `tests/integration/python-security-smoke.test.ts`
**Complexity:** complex
**Dependencies:** Tasks 1-9

- [ ] RED: Add a benchmark harness comparing manual search workflow vs taint-assisted workflow on fixed fixtures.
- [ ] GREEN: Record token/time deltas and gate release on both benchmark sanity and regression suite pass.
- [ ] Verify: `npx vitest run tests/integration/python-security-smoke.test.ts`
- [ ] Commit: `add Python security benchmark and release gate`

## Verification

After the full plan:
1. `npx vitest run tests/integration/python-search-tools.test.ts`
2. `npx vitest run tests/tools/python-constants-tools.test.ts tests/tools/django-view-security-tools.test.ts`
3. `npx vitest run tests/tools/taint-tools.test.ts tests/tools/python-security-tools.test.ts`
4. `npx vitest run tests/tools/pattern-tools-python.test.ts tests/integration/python-security-smoke.test.ts`
5. `npx vitest run`

## Release Outcome

When complete, CodeSift should be able to answer the following classes of questions in one or two tool calls instead of ad hoc grep chains:
- “Which Django views in scope are effectively authless?”
- “Does request input reach this sink?”
- “Is this redirect or HTML output guarded by a known-safe pattern?”
- “Which Python security findings are likely real vs framework-safe?”
