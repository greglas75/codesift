# Running codesift-mcp tests on the i9 farm, and CI off `ubuntu-latest`

Handoff brief. Everything below was measured on 2026-08-06/07 from this checkout, not inferred.
Each item says who owns it, what the evidence is, and what "done" looks like.

**Current state in one line:** `rt` works and the suite is *not* farm-clean — the mirror is not a git
repository, and at least 20 test files shell out to `git`. CI has never been migrated.

---

## 0. What already works — do not "fix" this

Measured, all green, warm cache:

| command | result |
|---|---|
| `rt echo FARM_OK` | exit 0, **14 s** total (queue 1s · deps 1s · build 7s) |
| `rt npx vitest run tests/storage/telemetry-retros.test.ts` | 11 tests pass, **11.7 s** |
| `rt -q npx vitest run tests/server/` | 5 files / 20 tests pass, **13 s** |

So the transport, the mirror sync, the dependency cache and the build phase are all fine. The
problems are (a) environment differences the suite is sensitive to, and (b) one `rt` UX defect that
makes a working job look dead.

---

## 1. FARM-SIDE (`~/DEV/i9-farma`) — the blocker

### 1.1 The job mirror is not a git repository

```
$ rt -q 'git rev-parse --is-shallow-repository; git log --oneline -1'
tf: exit 128
```

Exit 128 is "not a git repository". Consequences already observed in a farm run:

- `tests/scripts/journal-citation-check.test.ts` — **3 of 4 tests fail on the farm, 4 of 4 pass
  locally.** It drives `git` through `spawnSync`.
- Dozens of `[hotspot] git log failed for …: Command failed: git log --numstat --format=%H --since=90
  days ago` lines from other tests.

**20 test files invoke git** (`grep -rln` for a git invocation under `tests/`):

```
tests/tools/auto-refresh.test.ts              tests/tools/journal/git-client.test.ts
tests/tools/coupling-tools.test.ts            tests/tools/register/wrapper-wiring.test.ts
tests/tools/auto-index-worktree.test.ts       tests/integration/journal-e2e.test.ts
tests/tools/review-diff-tools.test.ts         tests/integration/review-diff.test.ts
tests/tools/plan-turn-stale-index.test.ts     tests/integration/config-files.test.ts
tests/tools/ast-query.test.ts                 tests/integration/tools.test.ts
tests/tools/project-profile-boundaries.test.ts tests/integration/index-repo.test.ts
tests/tools/hotspot-tools.test.ts             tests/cli/git-hooks-installer.test.ts
tests/tools/boundary-tools.test.ts            tests/cli/setup.test.ts
tests/tools/journal/generator-helpers.test.ts tests/utils/worktree.test.ts
```

Most create their own throwaway repos in a temp dir and are fine. The ones that read the CHECKOUT's
own history (`hotspot-tools`, `coupling-tools` / co-change, `review-diff`, `journal-*`) are not.

**Two ways to fix, and they are not equivalent:**

- **(A) Give the mirror a `.git`.** Right fix. `analyze_hotspots` and `co_change_analysis` are
  *features that read git history* — a farm that cannot exercise them can never prove they work.
  A shallow clone is not enough for `--since=90 days`; needs enough depth to cover the window.
- **(B) Skip git-dependent tests when `.git` is absent.** Cheap, and it silently removes coverage of
  two shipped tools on the runner that is supposed to be authoritative. If (B) is chosen, the skip
  must print a reason and be counted, never a silent pass.

Prefer (A). Use (B) only as a stopgap, with (A) filed.

### 1.2 `rt -q` does not stream a long run — a healthy job looks hung

Observed twice, and it cost real work: `rt -q npx vitest run` produced **zero output for 10+ minutes**
while the farm sat at 0/12 slots and 99% idle CPU. I concluded the farm was wedged and killed it.

It was not wedged. Re-running attached to the same job and dumped **1413 hidden lines** — it had been
running and producing output the whole time. `rt --queue` reports such a job as
`SUSPECT (silent 566s)`, which reads like a diagnosis and is actually just "no bytes have reached the
client".

**Fix:** either stream incrementally in `-q` mode, or make `--queue`'s `SUSPECT` distinguish "job
produced no output" from "client is not receiving output". Right now the label accuses the job of
something the client is doing.

**Second, smaller:** one `rt` invocation showed **two** jobs in `rt --queue` (`codesift-mcp` twice,
ages 10:17 and 10:16, and two local `bash /opt/homebrew/bin/rt` processes). Either the wrapper
double-submits or the queue double-counts. Worth one look — it doubles apparent load.

### 1.3 Node version differs from every developer machine

```
rt: note — node differs (local v24.18.0, farm v22.23.1)
```

`package.json` declares `engines: {"node": ">=20.0.0"}`, so v22 is legal — but this repo's storage
layer is built on `node:sqlite`, which landed in 22.5 and is still evolving. The entire SQLite
hardening in v0.14.0 was verified against v24 behaviour, including a probe of how the driver reports
faults (`code` vs `errcode`). A farm on v22 can pass or fail for reasons no developer will reproduce.

**Fix:** pin the farm's node for this repo via `.tf.json` `"node"` (the farm honours it), and make the
choice deliberate — either match developers (24) or declare 22 the supported floor and have someone
run the suite on 24 before release. Do not leave it accidental.

---

## 2. THIS REPO — small, unambiguous

### 2.1 `.tf.json` forces `NODE_ENV=test` on every phase

The farm warns about it on every run, and it is right:

```
tf: WARNING .tf.json sets NODE_ENV=test for EVERY phase — jest/vitest set it themselves,
tf:         and it makes builds produce dev bundles
```

The `env` block applies to build as well as test. Vitest sets `NODE_ENV` itself, so the entry buys
nothing and corrupts the build phase. **Drop `env` from `.tf.json`**, or move it into a profile that
genuinely needs it.

### 2.2 Tests must not depend on ambient machine state

Beyond git, five files reference network or tailnet endpoints:

```
tests/cli/daemon-token-transport.test.ts   tests/search/ollama-provider.test.ts
tests/cli/setup.test.ts                    tests/search/semantic.test.ts
tests/search/…                             (src/storage/telemetry/uploader.ts — prod, not test)
```

Note the farm **is** burst-i9, and `100.69.215.9:11434` (ollama) is that same host. A test that
reaches ollama behaves differently there than on a laptop — possibly *better*, which is worse,
because it hides a broken default. Each of these needs to either mock the endpoint or skip loudly.

### 2.3 Known pre-existing flake — FIXED 2026-08-10

`tests/server/http-session-cwd.test.ts > "keeps serving the same client after the server instance is
replaced"` failed **1 in 10** locally and **2 in 10 on the farm** (`rt --repeat 10`), where the extra
load widens the window.

It was not a readiness race, which is what this section previously guessed. Closing the first server
leaves the client's pooled keep-alive socket dangling, so the next request dies inside undici with
`UND_ERR_SOCKET` / "other side closed" **before it ever reaches the new process** — HTTP connection
reuse, not the session the test is about. The test now tolerates exactly one transport-level failure
(no HTTP response at all) and still propagates an MCP-level `no valid session`, which is the
regression it exists to catch. **12/12** after the change.

Worth copying elsewhere: `rt --repeat N <cmd>` runs N times in ONE job and reports the failure RATE.
It turns "is this a flake?" into a measurement instead of an argument.

### 2.4 Git-dependent tests must skip where the mirror has no `.git`

`tests/scripts/journal-citation-check.test.ts` validates cited SHAs with `git log --all`, and its
expected counts are counts against this repo's real history. The farm mirrors the working tree
**without `.git`**, so every SHA looked ungrounded and the file failed on an environment gap. It now
skips when `git rev-parse --git-dir` fails — visibly, as a skip — and runs in full locally.

The better fix is farm-side (mirror `.git`), and it is still listed in section 1. Until then, any
test that shells out to git needs the same guard: a red suite that everyone learns to ignore is worse
than a skip that says why.

---

## 3. CI — never migrated

```
.github/workflows/test.yml:20:    runs-on: ubuntu-latest
.github/workflows/release.yml:26:  runs-on: ubuntu-latest
```

Both jobs are on paid GitHub minutes while ~10 sibling repos run on coding-vps / burst-i9. The
migration procedure exists as a skill: **`migrate-repo-to-selfhosted-ci`**, and the worked example is
uptime's `docs/runbook/ci-self-hosted.md`.

Three things that specifically apply here, from the cross-repo rules:

- **Drop the remote cache when you change `runs-on`.** A self-hosted runner already has the files on
  local NVMe; leaving `setup-node`'s `cache: npm` on uploads a cache from a machine that does not
  need it. Measured elsewhere: 423 s of cache export on a job whose real build was 4 s.
- **This repo needs no CI ports** — no compose, no services. So no entry in the port registry.
- **It must stay private-or-trusted.** A self-hosted runner executes PR code. `greglas75/codesift` is
  public, so a fork-PR trigger on a self-hosted runner is a remote-code-execution path. Either keep
  `pull_request` from forks on `ubuntu-latest` and move only `push`/tag jobs, or gate on
  `github.event.pull_request.head.repo.full_name == github.repository`. **Do not skip this.**

---

## 4. Acceptance criteria

Done when all of these hold:

1. `rt -q npx vitest run` from a clean checkout finishes and reports the **same pass/fail set as a
   local run**, modulo the known flake in 2.3.
2. `rt -q 'git rev-parse --is-shallow-repository'` exits 0, and `analyze_hotspots` /
   `co_change_analysis` tests exercise real history rather than skipping.
3. `rt --queue` shows one job per invocation, and a long run streams output — no `SUSPECT` label on a
   job that is producing lines.
4. `.tf.json` no longer triggers the `NODE_ENV` warning.
5. The farm's node version for this repo is stated in `.tf.json`, not inherited by accident.
6. CI runs on a self-hosted runner for `push`/tags, with fork PRs demonstrably not able to execute on
   it.

## 5. The full suite did not finish on the farm — SOLVED 2026-08-10

**Root cause: `tests/storage/stable-host-id.test.ts` used `/proc/nonexistent-codesift-dir` as its
"data dir that cannot be written" fixture.** macOS has no `/proc`, so it passed locally. On Linux
`mkdirSync(path, { recursive: true })` under procfs does not fail — it **spins**, burning 100% of a
core forever. The non-recursive form throws `ENOENT` in 0 ms, which is what makes it look harmless.
Reproduced directly on the farm (Node v22.23.1):

```
mkdirSync("/proc/nope")                    -> throws ENOENT in 0 ms
mkdirSync("/proc/nope", {recursive:true})  -> never returns, 98.8% CPU
```

Fixed by pointing the fixture at a regular FILE with a path hung off it, which fails `ENOTDIR`
instantly on both platforms. The suite now finishes on the farm in **~36–55 s**, exit 0.

**Do not use `/proc`, `/dev`, or `/sys` paths in test fixtures.** A path that is merely absent on
the dev machine can be a live virtual filesystem on the runner.

How it was found, because the method generalises: the log records every completed test file, so
diffing that against `find tests -name '*.test.ts'` named the culprit in one step — 389 of 390 done,
one missing. No bisect needed.

Two earlier leads recorded here were **wrong** and are struck for the record: the `tests/scripts/`
shell-out benchmarks (they were simply the last files to print before the stall), and the suite
"not failing, just not finishing" framing (it was one file, and it was a real defect).

Two related farm behaviours confirmed while fixing it:

- `rt --cancel <runid>` is the supported way to free a wedged job. One wedged run held a core for
  **54 minutes**; the watchdog's silence threshold (600 s) never fired against 3211 s of silence, so
  **the silence timeout does not work** — still open, and it is what let a single stuck job idle a
  farm slot indefinitely.
- The local stream can go silent while the job is healthy. `SUSPECT (silent Ns)` in `rt --queue`
  means the CLIENT stopped receiving, not that the job is stuck. Check the farm-side log
  (`/home/tf/logs/<runid>.log`) before concluding anything — attempt 1 above was killed for exactly
  this misreading.

Note the arithmetic: attempt 3 was launched ~25 minutes before it died on a 14410 s clock. It did not
start that clock. **`rt` adopted an older, already-stuck job for the same mirror instead of
submitting a new one**, and then inherited its ceiling. That also explains the two queue entries for
one invocation in 1.2. A new invocation must never silently adopt a stuck job — or if it does, it
must say so, because the user is then debugging an execution they did not start.

Zero test failures were reported across all three attempts. The suite is not failing on the farm; it
is **not finishing**.

## 6. Doing this across all the repos — the shape of the problem

Measured under `~/DEV`:

- **103 directories carry `.tf.json`** — but they resolve to **43 real repos plus 60 worktrees named
  `-farmfix*` / `-cifix*` / `-ci-combined`.** traveliger 7, QuotasMobi 7, tgm-survey-tester 6,
  tgm-survey-platform 6, TGMSurveys 6, translation-qa 5, Inovoicer 5…

Sixty worktrees whose names say "farm fix" and "ci fix". The per-repo approach has already been tried
sixty times and has not converged. Each attempt also costs a fresh farm mirror seed and (until the
2026-08-06 registry fix) collapsed onto its parent's codesift registry name, so tools answered from
whichever copy indexed last.

**What is actually missing is not a fix — it is a verdict.** Every one of those worktrees exists
because somebody changed something and had no way to tell whether it worked.

### 6.1 Build the parity check first

One command per repo: run the suite locally and on the farm, diff the two pass/fail sets, print
`PASS` or the differing test names. Nothing else on this list matters as much, because without it
each repo is an investigation and with it each repo is a yes/no.

Then keep a table of 43 rows — repo, last parity result, date. The work becomes a queue instead of a
fog.

### 6.2 What is global, and what is not — do not confuse them

Measured, not assumed:

- **git-dependent tests are RARE.** Only two repos shell out to git from their tests: codesift-mcp
  (31 files) and QuotasMobi (1). So **do not** ship `.git` to every mirror to fix two repos — make it
  opt-in in `.tf.json` (`"git": true` or similar) and pay the cost only where a repo's tests read
  history. codesift-mcp is the outlier for a real reason: reading git history IS its product.
- **The `env` block is broader:** 9 of the `.tf.json` files set `env`, so 9 repos get the
  build-corrupting `NODE_ENV` warning. One mechanical sweep.
- **The `rt` defects in 1.2 and section 5 are global** and cost trust everywhere: silent long runs,
  a `SUSPECT` label that blames the job for a client problem, and job adoption that makes a run die
  on a stranger's clock. Fix these before touching any repo, or every parity result will be suspect.
- **Node parity is per-repo but mechanical:** each repo should pin its node in `.tf.json`; the farm
  should refuse-or-shout on a mismatch instead of printing a note.

### 6.3 Order

1. Fix the three `rt` defects (streaming, SUSPECT labelling, job adoption). Everything downstream
   depends on believing what the farm reports.
2. Ship the parity check.
3. Sweep the 9 `env` blocks.
4. Run parity across all 43; fix only what actually differs.
5. Delete the 60 `-farmfix*` / `-cifix*` worktrees once their repos pass — they are the debris of the
   approach this replaces.

## 7. Not verified — do first

I never got one clean full-suite farm run: my first attempt I killed myself (believing 1.2 was a
hang), and the second was cancelled by a timeout. **So the complete list of farm-only failures is not
known** — `journal-citation-check` (3/4) is confirmed, the rest is inferred from the `[hotspot] git
log failed` chatter.

First task for whoever picks this up:

```bash
rt npx vitest run 2>&1 | tee /tmp/farm-full.log      # NOT -q, and do not kill it
grep -E "^ *× |Test Files |Tests " /tmp/farm-full.log
```

Then diff that failure set against a local run before changing anything.
