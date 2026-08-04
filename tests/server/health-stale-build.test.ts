import { describe, it, expect, afterEach } from "vitest";
import { utimesSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../src/server.js";

/**
 * `/health` must go red when the code under the process is replaced.
 *
 * The daemon executes `dist/cli.js` and `npm run build` opens with `rmSync('dist')`, so a routine
 * build deletes the code a machine-wide service is running from. Node keeps serving from the
 * modules it already resolved; only the first LAZILY imported module fails, and it fails with a
 * message that reads like a source bug ("does not provide an export named 'getIndexSummary'" —
 * while that export was present in both src and dist).
 *
 * Measured 2026-08-04: in that state every tool call failed and `/health` answered `200 ok`. The
 * one endpoint whose job is to answer "am I usable" was the one thing blind to it.
 *
 * The check cannot be "import a module and see if it throws": a successful import is cached, so
 * the probe would keep returning the old working copy. It has to be the file's identity on disk.
 */

const SELF = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
let restore: { atime: Date; mtime: Date } | null = null;
let handle: Awaited<ReturnType<typeof startHttpServer>> | null = null;

afterEach(async () => {
  if (restore) {
    utimesSync(SELF, restore.atime, restore.mtime);
    restore = null;
  }
  await handle?.close();
  handle = null;
});

describe("/health reports a module graph left behind by a rebuild", () => {
  it("is 200 ok while the running code is still on disk unchanged", async () => {
    handle = await startHttpServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("is 503 stale once the file it started from is replaced", async () => {
    handle = await startHttpServer({ port: 0, host: "127.0.0.1" });

    // A rebuild changes mtime (and inode). Touching the module's own file reproduces the
    // observable condition without rebuilding the tree under a running test run.
    const before = statSync(SELF);
    restore = { atime: before.atime, mtime: before.mtime };
    const moved = new Date(before.mtimeMs + 5000);
    utimesSync(SELF, moved, moved);

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    // The status CODE, not a field in a 200 body: a supervisor and a shell one-liner both read the
    // code, and reporting "everything from here will fail" inside a 200 is exactly how the previous
    // version managed to look healthy while serving nothing.
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("stale");
    // The remedy belongs in the payload. Whoever hits this is looking at an export error that
    // points at the wrong file; without it they start by grepping source.
    expect(String(body.remedy)).toMatch(/kickstart/);
    expect(String(body.reason)).toMatch(/replaced|rebuild/i);
  });
});
