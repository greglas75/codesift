# Three-arm benchmark — plan

**Status:** ready to run; blocked on a paid-run decision (API spend) and a host (the August harness
lived on coding-vps, decommissioned 2026-09-07).
**Why now:** the 2026-09-22 competitive review found the category's credibility bar has moved from
token-only claims to *resolve rate + cost per solved task*: Graft (SWE-bench Verified, 50 instances,
same model, 54% → 66%), "Code Isn't Memory" (arXiv 2606.22417: with / without / agentic-grep, 3 seeds,
leak audit, published exclusion ledger). We have no such number, and our own August run said
something uncomfortable that a headline has to answer, not hide.

## What August already measured (`~/DEV/Jetbraintests`)

| run | pairs | CodeSift calls | cost Δ (median, paired) | quality |
|---|---|---|---|---|
| SWE-bench, arm B = codesift in the image | 20 | **0** (0 tasks used it) | +4% (p=0.41, noise) | 2 better / 0 worse |
| SkillsBench | 10 | used in 3 tasks | **+37% (p=0.002)** | 0 better / 2 worse |

So the failure to beat is not "CodeSift answers badly" — it is "the agent does not call it, and
having it installed costs tokens anyway". The arms below are designed to separate those two.

## Arms

| arm | surface | what it isolates |
|---|---|---|
| **A** native | no MCP server | baseline |
| **B** core | codesift, default surface (60 names) + capped instructions (A1) | today's product |
| **C** single | codesift, `CODESIFT_TOOL_SURFACE=single` (`explore`, `search_text`, `index_file`) | one-tool hypothesis (codegraph v1.6) |

Every arm pins the same model, the same Claude Code version (cost tables changed between 2.1.237
and 2.1.239 — see memory `benchmark-measurement-traps`), and the same effort.

## Tasks and seeds

- SWE-bench Verified, 50 instances, stratified by repo, fixed list committed before the first run.
- 3 seeds per (task, arm) → 450 trials.
- Leak audit: reject a trial whose transcript fetches the upstream fix (network log + diff match);
  publish the exclusion ledger with the results.

## Metrics (all paired per task, then aggregated)

1. **Resolve rate** — primary. McNemar on per-task majority-of-3.
2. **Cost per solved task** — re-priced from `n_input/n_cache/n_output` tokens with ONE rate table,
   never from the CLI's `cost_usd`.
3. Tool-call count, wall time, and **adoption**: share of trials with ≥1 codesift call. B and C are
   uninterpretable if adoption is ~0 again; report it first.
4. Dedupe session logs by `message.id` before summing (43% duplicate entries in August).

## Prerequisites

1. Ship A1–A5 in a release (or bake an `npm pack` tarball into the image — arm images install from
   npm today, `mk-harbor-arms.sh`).
2. Register the server in the image's Claude Code config, not only install it — the August arm B
   installed the package; the zero-call result must be ruled out as a wiring fault before it is read
   as agent behaviour. Check with one smoke trial that `tools/list` reaches the agent.
3. Host: waw-tf has the capacity; harbor needs Docker and ~50 GB for images.
4. `ANTHROPIC_API_KEY` with budget. Estimate from August (~$0.75/trial incl. cache): **~$340** for
   450 trials, plus ~$20 of smoke runs.

## Output

`benchmarks/results/2026-09-three-arm/` — per-trial JSONL, the exclusion ledger, the analysis script,
and a README table. The README number is generated from that directory by a script, and CI fails if
the README disagrees with it (ripwire / jCodeMunch pattern), so the headline cannot drift from data.
