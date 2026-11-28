<!-- zuvo-review -->
range: add5a43..ddd797d
files: CLAUDE.md, src/cli/help.ts, src/cli/hooks/search-first.ts, src/cli/setup/codex.ts, tests/cli/search-first.test.ts, tests/cli/setup.test.ts, tests/fixtures/codex/pre-tool-use-apply-patch.json, tests/fixtures/codex/rollout-command-execution.jsonl, tests/fixtures/codex/rollout-mcp-search-before-patch.jsonl
adversarial: zuvo/proofs/precheck-codex.txt
tier: 2
verdict: APPROVE

# precheck-write for Codex apply_patch

One `--multi` pass on f3644b8 (10 REVIEW BY). Rejected: both CRITICALs — the gate is a nudge for our own agents, not a security boundary (payload depth), and the gate must be appended because Codex trusts hooks by index. Fixed in ddd797d: setup keeps the gate's index stable on re-runs (a removed legacy entry before it shifts it once — documented and tested), rollout read once per hook call, `-c` unwrapped only for bash/sh/zsh, JSON-encoded `arguments` decoded. Farm: tests/cli 632 passed (1795886526-1966581-1985), lint green (1795886602-2316888-10631). Live `codex exec`: blocked, agent searched with rg, patch then went through.
