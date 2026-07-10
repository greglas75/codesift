<!-- RETRO -->

## 2026-07-10 review codesift-mcp d453ab3..209c975

### Telemetry
```
platform: codex | writer: codex-5.4 | reviewer: multi-provider unavailable | routing: routing-failed
codesift: indexed(6507symbols)
paths: shared=ok scripts=ok rules=ok
extension_check: ok
blind_audit: fix:3 | provider=internal-subagents | exit=0 | rows=12 | FULL=12 PARTIAL=0 NONE=0
adversarial: pass1=none(0,0,0) pass2=none(0,0,0) | cross_provider=false | timeout=60s | disposition=preserved:9 fixed:3 pre-existing-out-of-scope:2 false-positive:0
q_gates: 15/19 (Q7=1 Q11=0 Q13=1 Q15=1 Q17=1)
tests: 108/108 pass | extension=.test.ts
status: BLOCKED_INFRA | failure_cause=provider-auth-and-network
```

### Friction
- **Unclear:** Phase 3 validity rules distinguish rate limits from capability limits but do not classify simultaneous provider authentication and DNS failures.
- **Missing context:** The committed snapshot needed `src/parser/languages/*.wasm`, which is not stored in the archive, before characterization tests could run faithfully.
- **Most turns:** Four adversarial `--multi` attempts consumed the most retries; a preflight provider health command would have prevented all four.
- **Missing template:** N/A.

### Skill Gaps
- `review/SKILL.md` Validity Gate lacks an explicit terminal state for proven provider authentication/network unavailability.
- `review/SKILL.md` clean-snapshot verification does not mention non-versioned runtime assets such as parser WASM files.

### Missing Tools
- A provider-health preflight that validates authentication and one minimal response before large diff dispatch.
- A clean-snapshot test helper that hydrates required ignored runtime assets without copying unrelated worktree content.

### Worked Well
The origin classification and confidence-rescoring steps prevented eleven moved, pre-existing defects from being mislabeled as regressions introduced by the refactor.

### Session Cost
- **Files read:** 38
- **Files modified:** 10
- **Tool calls:** 62 total
- **Test runs:** 7 (pass: 5, environment-limited/fail: 2)
- **Adversarial passes:** 4 attempted, 0 valid
- **Biggest waste:** Dispatching full diff chunks after every configured provider had already demonstrated an authentication or network failure.

### Change Proposals (ranked by impact, up to 5)

**1.** FILE: `/Users/greglas/.codex/skills/review/SKILL.md` | SECTION: Adversarial preflight
CONTENT:
```
Before chunking a diff, run a one-line health prompt against every configured provider. If zero providers return valid content, record BLOCKED_INFRA with raw exit evidence and do not dispatch large chunks.
```
RATIONALE: Avoids repeated 60-second attempts that cannot produce review coverage.

**2.** FILE: `/Users/greglas/.codex/skills/review/SKILL.md` | SECTION: Clean snapshot verification
CONTENT:
```
When git archive omits required ignored runtime assets, hydrate only paths referenced by the build/test command and record each copied path as environment setup.
```
RATIONALE: Makes committed-snapshot testing reproducible without contaminating it with source edits.

**Impact ranking:**

| # | Change | Token savings | Quality impact |
|---|---|---:|---|
| 1 | Provider health preflight | ~4K/session | high |
| 2 | Runtime asset hydration rule | ~1K/session | medium |
