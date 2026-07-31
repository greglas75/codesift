<!-- zuvo-review -->
range: 9c57ace..8231041
files: rules/codesift.mdc,src/cli/commands.ts,src/cli/help.ts,src/cli/service.ts,src/instructions.ts,src/search/tool-embedding-storage.ts,src/server-helpers/repo-resolution.ts,src/server-helpers/response-hints.ts,src/storage/registry.ts,src/utils/worktree.ts,vitest.config.ts

# Code review — worktree resolution, daemon service, test isolation (9c57ace..8231041)

```
CODE REVIEW | TIER 3 (DEEP)
SCOPE:  11 production files, 20 files total, +1252/-45 | INTENT: FIX + FEAT
AUDIT:  self-review, adversarial against the running system (not fixtures) | RISK: MEDIUM
SELF-REVIEW: yes -> every claim re-verified by execution, 4 defects found and fixed in 8231041
```

`[CLASSIFIED] Diff type: mixed` — 11 production files, 9 test/config files.

## Verdict

**APPROVE**, with the four defects found during this review already fixed in the
range's head commit. The work is three independent fixes plus one feature; each
was verified by running it against the real system rather than by the suite
alone, because in two cases the suite passing was exactly what had been
misleading.

## What changed

**1. Test-suite flakiness (4aca730, b174177).** The suite went green ~2 runs in 5,
failing 1-3 different files each time, all green in isolation. The first commit
blamed the `vmForks` pool because switching to `forks` gave 8/8; that diagnosis
was **wrong** and b174177 says so. The real cause: 47 test files set
`process.env.CODESIFT_DATA_DIR` in `beforeAll` and `delete` it in `afterAll`,
while `singleFork` put every core test in one process and vitest still runs
files concurrently inside a fork. Whoever wrote the global last owned it. The
338 files that never set it fell through to the real `~/.codesift/registry.json`
— shared with every MCP server on the machine (38 live during diagnosis), where
`registerRepo` is a whole-file read-modify-write. Fixed by a per-file data dir
plus worker-per-file.

**2. Worktree resolution (9183c83).** `resolveRepoFromCwd` matched the longest
ancestor, and `<repo>` is an ancestor of `<repo>/.worktrees/<task>`, so an agent
inside a worktree silently got the main checkout's index. Measured on
ResearchShield: `result.service.ts` served as 4042 lines where the agent's own
file was 1415. Fixed by preferring the CWD's own working tree, plus hint H19 for
the still-unindexed case.

**3. Daemon supervision (dbb5fa2).** The shared daemon removes the per-window
memory cost but introduces a single point of failure; `codesift service` adds a
LaunchAgent / systemd user unit with restart-on-crash.

**4. Two production bugs found on the way.** `repo-resolution.ts` and
`tool-embedding-storage.ts` resolved paths from module-level
`join(homedir(), ".codesift", …)` constants, silently ignoring
`CODESIFT_DATA_DIR` that every other consumer honors.

## Findings (all fixed in 8231041)

**F1 — H19 fired on deliberate cross-repo queries. [MUST-FIX, fixed]**
`src/server-helpers/response-hints.ts`. Asking about another project from this
one produced "results describe DIFFERENT files" — true but useless, on every
`cross_repo_search`. This is the wallpaper failure the hint's own comment warns
about; a warning that cries wolf gets trained out of an agent's attention,
taking the real case with it. Fixed by `isAnswerFromWrongTree`, which also
requires the repo root to CONTAIN the CWD — the property that made the original
failure silent. Verified both directions against the live ResearchShield
worktree: fires there, silent for cross-repo, silent in the main checkout.

**F2 — path comparison ignored symlinks. [MUST-FIX, fixed]**
`src/utils/worktree.ts`. `findWorkingTree` used `resolve()`, so a repo under a
symlinked path yields `/tmp/x` from the registry and `/private/tmp/x` from the
CWD. On macOS /tmp IS a symlink, so an indexed worktree could fail to match
itself and never win resolution — silently reintroducing the very bug the commit
fixes. Both sides now go through `canonicalPath`, which falls back to the
lexical path so a stale registry entry cannot make it throw.

**F3 — launchctl aimed at a guessed uid. [RECOMMENDED, fixed]**
`src/cli/service.ts` used `process.getuid?.() ?? 501`. 501 is only the first
account macOS creates, so on any other account the fallback would bootstrap into
a different user's launchd domain. It never fires on darwin in practice, which
is the argument for removing rather than keeping it: a wrong action waiting for
an unusual host. Absent uid now prints the manual command.

**F4 — per-file test data dirs were never cleaned. [RECOMMENDED, fixed]**
6076 had accumulated. No teardown can do it (a run killed with ctrl-C never
reaches one), so each run now sweeps dirs older than an hour. The age guard is
load-bearing — a younger dir may belong to a concurrent run, and deleting it
would cause the exact `Repository ... not found` this setup prevents. Sweeping
is once per worker, not once per test file.

## Considered and accepted

- **`disableConsoleIntercept: true`** costs per-test attribution of console
  output in reporters. Accepted: suites shell out to `git` in throwaway dirs and
  emit hundreds of `fatal: not a git repository` lines, one of which landing
  during worker teardown failed a whole run with every test passing.
- **H19 costs a stat walk per response** with a `repo` arg. Bounded by the
  filesystem root, and `repoRootFor` reads an mtime-cached registry. Acceptable
  against silently answering from the wrong tree.
- **`withRegistryLock` is in-process only.** It cannot help across processes,
  which is why the test fix isolates data dirs rather than relying on it. Kept
  because the lost update it prevents is real in a single process too — watcher,
  background embedding and auto-index all call these unawaited.

## Known limits, not fixed here

- `local/rs_be` still holds 58 stale `.worktrees/` paths in its index. Today's
  walker skips dot-directories, so this is historical residue that survives
  incremental indexing — a separate change.
- `@types/node` is ^26 while `engines` says >=20 and CI tests Node 20/22, so
  types now describe APIs newer than the lowest supported runtime.

## Verification

Full suite 359 files / 5173 tests green. Six consecutive clean runs after the
flakiness fix (baseline was 2/5). Worktree behaviour, H19 in both directions,
daemon supervision (`kill -9` → launchd respawn in 6s → HTTP 200) all verified
against the running system, not fixtures. The worktree tests build a real
`git worktree add` rather than a hand-written `.git` file — the bug was a wrong
belief about git's layout, and a fixture encoding the same belief would have
passed while the product stayed broken.
