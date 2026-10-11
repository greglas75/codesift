// Bug it catches: a watcher of one tree editing the caches of ANOTHER tree indexed under the same repo
// name — its delete event removed the file's symbols from the new tree's in-memory BM25 (the cause of
// the explore / shown-source full-suite flake, 2026-10-11; a re-rooted repo in the field).
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexFolder, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { searchSymbols } from "../../src/tools/search-tools.js";
import { resetConfigCache } from "../../src/config.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cs-watch-token-"));
  process.env["CODESIFT_DATA_DIR"] = join(tmp, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  await stopAllWatchersForTesting();
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function tree(parent: string): Promise<string> {
  const root = join(tmp, parent, "same-name");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "shared.ts"), "export function sharedThing() { return 1; }\n");
  return root;
}

describe("watcher of another tree under the same repo name", () => {
  it("does not edit the index the name now points at", async () => {
    const a = await tree("a");
    const b = await tree("b");
    const first = await indexFolder(a); // watched
    const second = await indexFolder(b, { watch: false }); // same name, another tree
    expect(second.repo).toBe(first.repo);
    await searchSymbols(second.repo, "sharedThing", { top_k: 1 }); // cache b's BM25

    await rm(join(a, "src", "shared.ts"));
    // A's watcher is stopped now, so nothing is delivered; but an unguarded old watcher would have
    // edited B's cache within this window (verified: the previous code fails here).
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const names = (await searchSymbols(second.repo, "sharedThing", { top_k: 3 })).map((r) => r.symbol.name);
    expect(names).toContain("sharedThing");
  });
});
