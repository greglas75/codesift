import { mkdtempSync } from "node:fs";
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
process.env["CODESIFT_DATA_DIR"] = mkdtempSync(join(tmpdir(), "codesift-test-file-"));
