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

### 2.3 Known pre-existing flake, do not let it mask a regression

`tests/server/http-session-cwd.test.ts > "keeps serving the same client after the server instance is
replaced"` fails **1 in 10** runs in isolation (measured at v0.14.0; matches the rate recorded for
B-6 at v0.12.0). Fix the readiness race in the test's own restart sequence, or the farm will produce
red runs nobody trusts.

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

## 5. Not verified — do first

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
