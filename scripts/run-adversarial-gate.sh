#!/usr/bin/env bash
# Pre-merge adversarial gate (SC4 — Task 21 of monorepo workspace
# intelligence plan). Runs `adversarial-review` on the spec and the plan,
# writes the JSON artifacts to canonical paths, and exits non-zero if any
# finding has severity == "CRITICAL".
#
# Usage: bash scripts/run-adversarial-gate.sh
# Exit codes: 0 = no CRITICAL findings; 1 = CRITICAL found; 2 = tooling missing.

set -euo pipefail

SPEC="docs/specs/2026-05-01-monorepo-workspace-intelligence-spec.md"
PLAN="docs/specs/2026-05-01-monorepo-workspace-intelligence-plan.md"
SPEC_ARTIFACT="docs/specs/2026-05-01-monorepo-workspace-intelligence-adversarial.json"
PLAN_ARTIFACT="docs/specs/2026-05-01-monorepo-workspace-intelligence-plan-adversarial.json"

if ! command -v adversarial-review >/dev/null 2>&1; then
  # Fallback to bundled script under zuvo plugin cache
  CANDIDATE=$(ls "$HOME"/.claude/plugins/cache/zuvo-marketplace/zuvo/*/scripts/adversarial-review.sh 2>/dev/null | head -1)
  if [ -z "${CANDIDATE:-}" ]; then
    echo "adversarial-review not found in PATH and no fallback under ~/.claude/plugins/cache/zuvo-marketplace/" >&2
    echo "Install via 'npm i -g zuvo' or skip this gate locally." >&2
    exit 2
  fi
  REVIEWER="$CANDIDATE"
else
  REVIEWER=$(command -v adversarial-review)
fi

run_one() {
  local mode="$1" file="$2" artifact="$3"
  echo "Running adversarial review: $mode -> $file" >&2
  "$REVIEWER" --json --mode "$mode" --files "$file" > "$artifact" 2>/dev/null || {
    echo "adversarial-review run failed for $file" >&2
    return 1
  }
  # Count CRITICAL findings via grep (avoid jq dependency)
  local critical_count
  critical_count=$(grep -o '"severity"[[:space:]]*:[[:space:]]*"CRITICAL"' "$artifact" | wc -l | tr -d ' ')
  echo "$mode artifact: $artifact (CRITICAL count: $critical_count)" >&2
  if [ "$critical_count" -gt 0 ]; then
    return 1
  fi
  return 0
}

EXIT=0
run_one spec "$SPEC" "$SPEC_ARTIFACT" || EXIT=1
run_one plan "$PLAN" "$PLAN_ARTIFACT" || EXIT=1

if [ "$EXIT" -ne 0 ]; then
  echo "Adversarial gate FAILED: CRITICAL findings present in spec or plan artifact." >&2
  exit 1
fi
echo "Adversarial gate PASS: zero CRITICAL findings." >&2
exit 0
