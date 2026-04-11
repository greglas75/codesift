# Implementation Plan: React Compiler + Ecosystem Patterns

**planning_mode:** inline
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 5 batched tasks (12 patterns + 1 composite tool)

## Task 1: React Compiler bailout patterns (7 patterns)
- compiler-side-effect-in-render
- compiler-ref-read-in-render
- compiler-prop-mutation
- compiler-state-mutation
- compiler-try-catch-bailout
- compiler-redundant-memo
- compiler-interior-mutability

## Task 2: useEffect pain point patterns (2 patterns)
- useEffect-missing-cleanup
- useEffect-setState-loop

## Task 3: Next.js 16 cache patterns (2 patterns)
- nextjs-use-cache-without-tag
- nextjs-revalidatetag-deprecated

## Task 4: TanStack Query pattern (1 pattern)
- tanstack-missing-invalidation

## Task 5: audit_compiler_readiness composite tool + tests + commit
