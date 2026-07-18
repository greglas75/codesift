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
<!-- RETRO -->

## 2026-07-10 refactor codesift-mcp src/tools/astro-actions.ts

### Telemetry
```
platform: codex | writer: codex-5.4 | reviewer: codex sub-agent | routing: same-model-fallback
codesift: indexed(29072symbols)
paths: shared=ok scripts=ok rules=ok
extension_check: ok
blind_audit: fix:8 | provider=codex-subagent | exit=0 | rows=8 | FULL=8 PARTIAL=0 NONE=0
adversarial: pass1=none(0,0,0) pass2=none(0,0,0) | cross_provider=false | timeout=60s
q_gates: 13/19 (Q7=0 Q11=0 Q13=1 Q15=1 Q17=1)
tests: 39/39 pass | extension=.test.ts
status: BLOCKED_INFRA | failure_cause=adversarial-provider-auth-network
```

### Friction
- **Unclear:** Phase 3.5 requires the pure refactor commit before bug remediation, while the adversarial gate can block that commit after the independent auditor has already found mandatory fixes.
- **Missing context:** `src/tools/astro-actions.ts` relied on undocumented best-effort failure semantics that only became visible during the CQ8 audit.
- **Most turns:** Two 60-second adversarial rotations plus provider fallbacks consumed the most retries without returning review content.
- **Missing template:** A standard bounded-audit result shape with `truncated` and `files_skipped` metadata was absent.

### Skill Gaps
- `refactor/SKILL.md` Phase 3.5 needs an explicit recovery path when CQ findings exist but provider infrastructure blocks the pure-refactor commit.
- `codesift-setup.md` preloading does not expose hidden refactor analysis tools on this host despite successful `describe_tools` discovery.

### Missing Tools
- A provider authentication/health preflight before uploading a 30K-character adversarial payload.
- A reusable bounded-file scanner for audit tools with explicit partial-result metadata.

### Worked Well
The characterization lock caught behavior-preservation mistakes around public exports and handler return detection, while the independent CQ auditor prevented a structurally cleaner split from being mislabeled complete with inherited false-clean behavior.

### Session Cost
- **Files read:** 20
- **Files modified:** 11
- **Tool calls:** 55 total
- **Test runs:** 8 (pass: 7, environment-limited: 1)
- **Adversarial passes:** 2 attempted, 0 valid
- **Biggest waste:** Sending the full enriched diff after every external provider was already known to be unavailable.

### Change Proposals (ranked by impact, up to 5)

**1.** FILE: `/Users/greglas/.codex/skills/refactor/SKILL.md` | SECTION: Adversarial Review
CONTENT:
```
Run a minimal provider-health prompt before assembling the enriched diff. If every configured provider fails authentication/connectivity, persist BLOCKED_INFRA immediately and skip large payload dispatch.
```
RATIONALE: Prevents repeated high-latency calls with no possible reviewer output.

**2.** FILE: `/Users/greglas/.codex/skills/refactor/SKILL.md` | SECTION: Phase 3.5 recovery
CONTENT:
```
When the blind audit finds fix-now bugs but adversarial infrastructure blocks commit 1, preserve the staged pure diff and record a remediation queue in CONTRACT; resume must run adversarial first, commit the pure refactor, then apply the queued fixes with red/green proof.
```
RATIONALE: Makes the blocked state resumable without mixing behavior changes into the pure split.

**Impact ranking:**

| # | Change | Token savings | Quality impact |
|---|---|---:|---|
| 1 | Provider health preflight | ~4K/session | high |
| 2 | Blocked remediation queue | ~2K/session | high |
