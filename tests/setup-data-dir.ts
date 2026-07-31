import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Give every test FILE its own CodeSift data dir.
 *
 * `setupFiles` runs once per test file, in that file's worker, before the file
 * is imported — which is the only hook that can hand out a fresh value for a
 * process-global before the file's own `beforeAll` runs.
 *
 * This closes two races that between them produced all of this suite's
 * flakiness — random files failing, never the same ones, every one of them
 * green in isolation, every failure an empty result or
 * `Repository "..." not found`:
 *
 *  1. Shared `process.env.CODESIFT_DATA_DIR`. 47 test files point it at their
 *     own tmpdir in `beforeAll` and `delete` it in `afterAll`. Whenever two
 *     files share a process, the variable belongs to whoever wrote it last:
 *     file A indexes fixtures into /tmp/A, file B overwrites the variable with
 *     /tmp/B, and A's assertions then look up A's repo in B's registry.
 *     A per-file value means a file can only ever race with itself.
 *
 *  2. Shared registry file across worker processes. One data dir for the whole
 *     run puts every worker on the same `registry.json`, and `registerRepo` is
 *     a whole-file read-modify-write — worker 1 reloads, worker 2 adds a repo,
 *     worker 1 writes its stale snapshot back, worker 2's repo is gone. That is
 *     cross-process, so no in-process lock can prevent it; separate dirs can.
 *
 * Files that set the variable themselves keep working — they simply override a
 * private default instead of a shared one, and their `afterAll` delete no
 * longer strands the next file with no value at all, because setup re-runs.
 */
const PREFIX = "codesift-test-file-";

/**
 * Sweep dirs this file created on earlier runs.
 *
 * One per test file means ~360 per full run, each holding a registry and
 * whatever indexes the file built — left alone they accumulate at hundreds of
 * megabytes a day on a machine that runs the suite often. There is no teardown
 * hook that can do it (a run killed with ctrl-C never reaches one), so each run
 * cleans up after the previous ones instead.
 *
 * The age guard is what makes this safe under concurrent runs: a directory
 * younger than an hour may belong to a suite running right now in another
 * process, and deleting it would fail that run with exactly the
 * `Repository ... not found` this whole setup exists to prevent.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Once per worker process, not once per test file. setupFiles runs for every
 * file, so without this a full readdir of a tmpdir holding thousands of entries
 * happens ~360 times per run — a lot of syscalls for a job that one pass
 * finishes. The flag lives in the environment because module state does not
 * survive per-file isolation while the process environment does.
 */
function sweepStaleDataDirs(): void {
  const SWEPT_FLAG = "CODESIFT_TEST_TMP_SWEPT";
  if (process.env[SWEPT_FLAG] === "1") return;
  process.env[SWEPT_FLAG] = "1";
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // Never let cleanup failure stop the suite from running.
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const full = join(root, entry);
    try {
      if (now - statSync(full).mtimeMs < MAX_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      // Racing another sweeper, or not ours to delete — skip it.
    }
  }
}

sweepStaleDataDirs();

process.env["CODESIFT_DATA_DIR"] = mkdtempSync(join(tmpdir(), PREFIX));
