# Phase: Journal Pipeline — Citation Golden Fixture

## Intent

Ship the full journal pipeline in four beats. Initial scaffold landed in bfa5fce,
followed by phase-detector work in b718659 and 7729fc4. The fabricated commit
abcdef1 never existed — it was listed in an early draft by mistake.

## Reality

Core delivery happened across 3e4b644, 5ccbb80, b395926, and 66deb67 on 2026-04-21.
The ed8ec72 commit added optional deps for LLM + YAML config parsing. An early
prototype with id 1234567 was proposed but never merged.

## Significance

The git-client work (cd1a1dc) and phase-detector (3e4908a) together established
the two-layer heuristic that drives auto-detection. Template scaffolding came in
ef6b781 and 4d4cf88.

## Blockers Resolved

Two dependency issues were cleared in 2bbf62d and 5c03108. The stale release
tag `v99.99.99` referenced in the original roadmap was never cut. The milestone
was considered closed but commit abcdef1 was never verified. A future date
9999-12-31 was used as a placeholder in the roadmap and is not grounded.
