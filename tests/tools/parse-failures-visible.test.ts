// A file that fails to parse is simply ABSENT from the index, and absence is indistinguishable
// from "this file has no symbols". The only trace was a `console.warn`, which under MCP goes to the
// server's stderr — invisible to the agent that asked. Observed here when a crashing parser worker
// made an edited file's symbols disappear while `index_folder` still reported success; the missing
// symbol looked like a bug in the seeding logic for the better part of an hour.
//
// So the count travels back in the RESULT. These tests pin that, and that a clean index stays
// clean — a failure field present on every response would be noise, and noise gets ignored.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFolder } from "../../src/tools/index-tools/folder-indexer.js";
import { parseFiles } from "../../src/tools/index-tools/parse.js";

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cs-parsefail-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "t@t"], root);
  git(["config", "user.name", "t"], root);
  return root;
}

// Root can read anything, so the forced-permission failure below proves nothing there.
const canDenyReads = typeof process.getuid === "function" && process.getuid() !== 0;

describe("parse failures are reported, not swallowed", () => {
  it.skipIf(!canDenyReads)("names the file parseFiles could not read", async () => {
    const root = repoWith({
      "src/good.ts": "export function alpha(): void {}\n",
      "src/locked.ts": "export function beta(): void {}\n",
    });
    chmodSync(join(root, "src/locked.ts"), 0o000);
    try {
      const out = await parseFiles(
        [join(root, "src/good.ts"), join(root, "src/locked.ts")],
        root,
        "local/test",
      );
      expect(out.failed).toEqual(["src/locked.ts"]);
      // The good file still lands — one bad file must not cost the whole batch.
      expect(out.symbols.some((s) => s.name === "alpha")).toBe(true);
    } finally {
      chmodSync(join(root, "src/locked.ts"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!canDenyReads)("surfaces the count and a sample in the index_folder result", async () => {
    const root = repoWith({
      "src/good.ts": "export function gamma(): void {}\n",
      "src/locked.ts": "export function delta(): void {}\n",
    });
    chmodSync(join(root, "src/locked.ts"), 0o000);
    try {
      const result = await indexFolder(root, { watch: false }) as {
        parse_failures?: number;
        parse_failed_sample?: string[];
      };
      expect(result.parse_failures).toBe(1);
      expect(result.parse_failed_sample).toContain("src/locked.ts");
    } finally {
      chmodSync(join(root, "src/locked.ts"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("says nothing when every file parsed", async () => {
    const root = repoWith({ "src/good.ts": "export function epsilon(): void {}\n" });
    try {
      const result = await indexFolder(root, { watch: false }) as Record<string, unknown>;
      expect("parse_failures" in result).toBe(false);
      expect("parse_failed_sample" in result).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
