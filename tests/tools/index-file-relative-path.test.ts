import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexFile } from "../../src/tools/index-tools/file-indexer.js";
import { runWithRequestContext } from "../../src/server-helpers/request-context.js";

/**
 * A relative path used to be resolved against the PROCESS's directory. Under stdio that is the
 * project, so it worked; under the shared daemon the process runs from `/` (launchd), so
 * `apps/api/x.ts` became `/apps/api/x.ts` and the call failed. Measured 2026-08-30: 20 of 36 calls
 * in one 15-minute window, every one of them the PostToolUse hook reporting an edit — so every one
 * of those edits went unindexed.
 */
describe("index_file and relative paths", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("explains the missing working directory instead of blaming the repo", async () => {
    // The old message was `No indexed repo contains "/apps/api/x.ts"` — true, and useless: the
    // leading slash IS the diagnosis and nobody reads it that way.
    await expect(indexFile("apps/api/some-file.ts")).rejects.toThrow(
      /carries no working directory/i,
    );
  });

  it("names the mechanism that fixes it", async () => {
    await expect(indexFile("apps/api/some-file.ts")).rejects.toThrow(/\?cwd=/);
  });

  it("resolves against the REQUEST's directory when one is in scope", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-relpath-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");

    // Not indexed, so it still refuses — but on the REPO, having resolved the path correctly.
    // The distinction is the whole point: the daemon now knows which tree the caller meant.
    await runWithRequestContext({ cwd: dir }, async () => {
      await expect(indexFile("src/a.ts")).rejects.toThrow(/No indexed repo contains/);
      await expect(indexFile("src/a.ts")).rejects.toThrow(new RegExp(dir!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  });

  it("leaves an absolute path alone", async () => {
    await expect(indexFile("/nowhere/that/exists/x.ts")).rejects.toThrow(
      /No indexed repo contains "\/nowhere\/that\/exists\/x\.ts"/,
    );
  });
});
