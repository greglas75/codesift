import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { indexFolder } from "../../src/register-tool-groups/deps.js";
import { searchText } from "../../src/tools/search-tools.js";

/**
 * A `--glob` containing a `/` is anchored to ripgrep's WORKING DIRECTORY, not to
 * the search path it is given. Under stdio that never showed: the server
 * inherited the client's project directory, so `src/**` anchored correctly by
 * accident. The shared daemon runs from `/`, where the same glob anchors at the
 * filesystem root and matches nothing.
 *
 * The failure mode is why this test exists rather than a comment: a scoped
 * search returned an empty result set, which reads as "no matches in that
 * subtree" instead of "the scope was silently dropped" — and `search_text`'s own
 * timeout hint recommends exactly the broken form (`file_pattern="src/**\/*.ts"`),
 * so the suggested remedy made things worse.
 */
let dir: string;
let repo: string;
const originalCwd = process.cwd();

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "cs-glob-cwd-")));
  await mkdir(join(dir, "src", "tools"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "src", "top.ts"), "export const marker = 'NEEDLE_TOKEN';\n");
  await writeFile(join(dir, "src", "tools", "deep.ts"), "export const deep = 'NEEDLE_TOKEN';\n");
  await writeFile(join(dir, "lib", "other.ts"), "export const other = 'NEEDLE_TOKEN';\n");

  const res = (await indexFolder(dir)) as { repo?: string } | undefined;
  repo = res?.repo ?? `local/${dir.split("/").pop()}`;
}, 60_000);

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
});

function count(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const matches = (result as { matches?: unknown[] } | null)?.matches;
  return Array.isArray(matches) ? matches.length : 0;
}

describe("scoped file_pattern does not depend on the process working directory", () => {
  it("honours a path glob when the process runs from an unrelated directory", async () => {
    // The daemon's situation: cwd is nowhere near the repo being searched.
    process.chdir(tmpdir());
    try {
      const scoped = await searchText(repo, "NEEDLE_TOKEN", {
        file_pattern: "src/**/*.ts",
        group_by_file: true,
      });
      // src/top.ts + src/tools/deep.ts — and NOT lib/other.ts.
      expect(count(scoped)).toBe(2);

      const deeper = await searchText(repo, "NEEDLE_TOKEN", {
        file_pattern: "src/tools/*.ts",
        group_by_file: true,
      });
      expect(count(deeper)).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  }, 60_000);

  it("gives the same answer from inside the repo as from outside it", async () => {
    process.chdir(tmpdir());
    const outside = count(
      await searchText(repo, "NEEDLE_TOKEN", { file_pattern: "src/**/*.ts", group_by_file: true }),
    );
    process.chdir(dir);
    const inside = count(
      await searchText(repo, "NEEDLE_TOKEN", { file_pattern: "src/**/*.ts", group_by_file: true }),
    );
    process.chdir(originalCwd);
    expect(outside).toBe(inside);
  }, 60_000);

  it("still matches basename globs, which were never affected", async () => {
    process.chdir(tmpdir());
    try {
      const all = await searchText(repo, "NEEDLE_TOKEN", {
        file_pattern: "*.ts",
        group_by_file: true,
      });
      expect(count(all)).toBe(3);
    } finally {
      process.chdir(originalCwd);
    }
  }, 60_000);
});
