# Review: precheck-bash hook (4642489)

**Date:** 2026-04-09
**Tier:** 2 (STANDARD) | **Verdict:** CONDITIONAL PASS | **Risk:** LOW
**Scope:** 6 files, +292/-3 lines | **Intent:** FEATURE
**Adversarial:** codex, gemini, claude

## Findings

### MUST-FIX (1)
- **R-1** `grep -R` (uppercase) bypasses hook. Regex `/\s-\w*r\w*\s/` uses literal lowercase `r`. Fix: `/\s-\w*[rR]\w*\s/`. [CROSS:claude] Confidence: 95.

### RECOMMENDED (2)
- **R-2** `--hooks` silently installs rules without disclosure. Confidence: 72.
- **R-3** String literals cause false positives (`echo "grep -r ..."` denied). Confidence: 60.

### NIT (4)
- **R-4** Double `installRules` when `--hooks` + `--rules`. Idempotent.
- **R-5** Missing tests: `grep -R`, `grep --recursive`, non-recursive grep.
- **R-6** Trailing `\s` misses `grep -r.|pipe`.
- **R-7** `find -newer` incorrectly blocked.

## Scores
- CQ: 9/9 applicable (19 N/A — pure CLI utility) → PASS
- Q: 15/15 applicable → PASS

## Run
2026-04-09T06:11:26Z	review	codesift-mcp	9/9	15/15	WARN	-	tier-2	precheck-bash hook — grep -R bypass	main	4642489
