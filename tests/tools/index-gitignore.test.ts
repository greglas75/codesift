// Bug it catches: gitignored files indexed (the walker), indexed back by an edit (index_file), or a
// reindex that drops them refused as a broken walk (rejected_partial).
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexFile, indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resetGitIgnoredCacheForTesting } from "../../src/utils/walk/gitignore.js";

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cs-index-gi-"));
  root = join(tmp, "gi-project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "copies"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmp, ".codesift");
  resetConfigCache();
  resetGitIgnoredCacheForTesting();
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "src", "real.ts"), "export function realThing() { return 1; }\n");
  for (let i = 0; i < 30; i++) {
    await writeFile(join(root, "copies", `copy${i}.ts`), `export function copy${i}() { return ${i}; }\n`);
  }
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("indexing honours .gitignore", () => {
  it("accepts the reindex that drops a newly ignored tree, instead of rejecting it as partial", async () => {
    const before = await indexFolder(root, { watch: false });
    expect(before.file_count).toBe(31);

    await writeFile(join(root, ".gitignore"), "copies/\n");
    resetGitIgnoredCacheForTesting();
    const after = await indexFolder(root, { watch: false });

    expect(after.status).toBeUndefined();
    expect(after.file_count).toBe(1); // src/real.ts; the 30 ignored copies are gone
  });

  it("refuses to index an ignored file on edit", async () => {
    await writeFile(join(root, ".gitignore"), "copies/\n");
    await indexFolder(root, { watch: false });
    const result = await indexFile(join(root, "copies", "copy1.ts"));
    expect(result).toMatchObject({ skipped: true, excluded_by: ".gitignore" });
  });
});
