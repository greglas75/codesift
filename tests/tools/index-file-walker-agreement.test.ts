// There are two doors into an index and only one of them had a filter.
//
// `walkDirectory` refuses node_modules, vendor, dist and every dot-directory. `indexFile` refused
// nothing — and the PostToolUse hook calls it after EVERY agent edit, so anything an agent touched
// went in. Measured on the live indexes: 3,067 files across 33 repositories under
// `.claude/worktrees/`, 1,911 in ResearchShieldNew alone, real parsed source (218 symbols in the
// largest) from throwaway per-agent checkouts that no longer exist. They produced 29,000 lines of
// `failed to read indexed file` in one day and stayed searchable long after deletion.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFolder } from "../../src/tools/index-tools/folder-indexer.js";
import { indexFile } from "../../src/tools/index-tools/file-indexer.js";
import { parseOneFile } from "../../src/tools/index-tools/parse.js";
import { loadIndex, saveIncremental } from "../../src/storage/index-store.js";
import { getRepo } from "../../src/storage/registry.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";

let dataDir: string;
let repo: string;
let prevData: string | undefined;

const JUNK_REL = join(".claude", "worktrees", "agent-abc", "src", "junk.ts");

beforeEach(() => {
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-walk-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  repo = mkdtempSync(join(tmpdir(), "cs-walk-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.ts"), "export function keeper(): void {}\n");
  mkdirSync(join(repo, ".claude", "worktrees", "agent-abc", "src"), { recursive: true });
  writeFileSync(join(repo, JUNK_REL), "export function junkFn(): void {}\n");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.ts"), "export const dep = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
});

afterEach(() => {
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  resetConfigCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("index_file agrees with the walker", () => {
  it("refuses a file the walk would never have visited", async () => {
    await indexFolder(repo, { watch: false });

    const result = await indexFile(join(repo, JUNK_REL));

    expect(result.skipped).toBe(true);
    expect(result.excluded_by).toBe(".claude");
    expect(result.symbol_count).toBe(0);
  });

  it("refuses node_modules by the same rule, not a separate list", async () => {
    await indexFolder(repo, { watch: false });

    const result = await indexFile(join(repo, "node_modules", "dep", "index.ts"));

    expect(result.excluded_by).toBe("node_modules");
  });

  it("prunes what an earlier run already let in", async () => {
    const summary = await indexFolder(repo, { watch: false });
    const meta = await getRepo(loadConfig().registryPath, summary.repo);
    expect(meta).toBeTruthy();

    // Plant the row exactly as a pre-fix run would have: parse the real file, save it incrementally.
    // Refusing alone would leave the 3,067 existing files searchable forever, because the checkouts
    // they came from are deleted and nothing will ever touch them again.
    const parsed = await parseOneFile(join(repo, JUNK_REL), repo, summary.repo);
    expect(parsed).toBeTruthy();
    await saveIncremental(meta!.index_path, JUNK_REL, parsed!.symbols, parsed!.entry);
    expect((await loadIndex(meta!.index_path))!.files.some((f) => f.path === JUNK_REL)).toBe(true);

    await indexFile(join(repo, JUNK_REL));

    const after = await loadIndex(meta!.index_path);
    expect(after!.files.some((f) => f.path === JUNK_REL)).toBe(false);
    expect(after!.symbols.some((s) => s.file === JUNK_REL)).toBe(false);
    // The repo's own source must survive the prune.
    expect(after!.files.some((f) => f.path === join("src", "keep.ts"))).toBe(true);
  });

  it("still indexes an ordinary file, and a dot-FILE at a normal path", async () => {
    const summary = await indexFolder(repo, { watch: false });
    writeFileSync(join(repo, "src", "added.ts"), "export function added(): void {}\n");

    const ok = await indexFile(join(repo, "src", "added.ts"));
    expect(ok.excluded_by).toBeUndefined();
    expect(ok.symbol_count).toBeGreaterThan(0);
    expect(summary.repo).toBeTruthy();
  });
});
