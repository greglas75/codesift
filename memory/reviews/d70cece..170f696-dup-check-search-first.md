<!-- zuvo-review -->
range: d70cece..170f696
adversarial: zuvo/proofs/dup-check-search-first.txt
files: CHANGELOG.md,CLAUDE.md,README.md,src/cli.ts,src/cli/commands-dup-check.ts,src/cli/commands.ts,src/cli/help.ts,src/cli/hooks.ts,src/cli/hooks/search-first.ts,src/cli/hooks/shared.ts,src/cli/setup/claude.ts,src/tools/clone-tools.ts,src/tools/dup-check-git.ts,src/tools/dup-check-tools.ts,tests/cli/dup-check.test.ts,tests/cli/search-first.test.ts,tests/tools/dup-check-git.test.ts,tests/tools/dup-check-tools.test.ts

codesift dup-check (duplicated-code gate on a branch's new code) + precheck-write (search-first hook on new source files).
Cross-provider review (AGY, CODEX-5.3, OPENROUTER, BYTEPLUS, ZAI, CLAUDE; 3 chunks): 3 CRITICAL + ~27 WARNING.
Fixed (regression test fails on pre-fix code): local base containing HEAD → empty diff; CRLF marker ignored; Windows separators in excluded dirs; tests wrote to the real ~/.codesift; tool-result lines parsed needlessly; short read; no-server test asserted no decision.
Rejected: cli.ts catch path keeps exit 0 (it calls process.exit(1)); non-UTF-8 filenames, 512 MB git maxBuffer (errors exit 1, fail visibly); vi.mock hoisting (factory reads hookEnv at call time).
Deferred as accepted trade-offs: missing origin.kind = prompt (subagent briefs have none; a false deny costs one lookup); missing subagent transcript allows (fail open by design); --no-renames reports a moved file's old clones; same-file same-name methods skipped; MAX_MATCHES cap edge with markers.
Tests: rt 1793205024-2806226-7990 580 passed; lint rt 1793205089-2874641-31878 exit 0; tgm feature worktree default base origin/develop, 6.6 s, 0 duplicates.
