import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDeadCode } from "../../src/tools/symbol-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";

/**
 * `find_dead_code` is the most destructive empty answer in the tool surface: an agent reads
 * "no references found" as "safe to delete". These tests pin the distinction between a result
 * that is ABOUT THE CODE and one that is about how much of the code the scan actually read.
 */

let dir: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-deadcov-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = join(dir, ".data");
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = join(dir, "repo");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return root;
}

describe("find_dead_code coverage reporting", () => {
  it("reports a complete scan when every indexed file was read", async () => {
    const root = await makeRepo({
      "src/a.ts": "export function used() { return 1; }\nexport function orphan() { return 2; }\n",
      "src/b.ts": "import { used } from './a.js';\nexport const x = used();\n",
    });
    const indexed = await indexFolder(root, { watch: false });
    const result = await findDeadCode(indexed.repo);

    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.files_read).toBe(result.coverage.files_indexed);
    expect(result.coverage.detail).toBeUndefined();
    // Only under a complete scan is the candidate list a statement about the code.
    expect(result.candidates.some((c) => c.name === "orphan")).toBe(true);
    expect(result.candidates.some((c) => c.name === "used")).toBe(false);
  });

  it("reports PARTIAL, with a reason, when files could not be read", async () => {
    const root = await makeRepo({
      "src/a.ts": "export function maybeUsed() { return 1; }\n",
      "src/hidden.ts": "import { maybeUsed } from './a.js';\nexport const y = maybeUsed();\n",
    });
    const indexed = await indexFolder(root, { watch: false });

    // The only reference to maybeUsed now lives in a file the scan cannot read. Without a
    // coverage signal the symbol looks exactly like genuinely dead code.
    await chmod(join(root, "src/hidden.ts"), 0o000);
    let result;
    try {
      result = await findDeadCode(indexed.repo);
    } finally {
      await chmod(join(root, "src/hidden.ts"), 0o644).catch(() => {});
    }

    if (process.getuid?.() === 0) return; // root can read anything; the test would be a false pass
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.files_unreadable).toBeGreaterThan(0);
    expect(result.coverage.detail).toMatch(/do NOT delete on this result alone/i);
    expect(result.coverage.files_read).toBeLessThan(result.coverage.files_indexed);
  });

  it("keeps list truncation separate from scan completeness", async () => {
    // The two used to share one boolean. They mean opposite things: a cut-off LIST leaves the
    // shown candidates trustworthy, a short SCAN makes them suspect.
    const root = await makeRepo({
      "src/a.ts": "export function solo() { return 1; }\n",
    });
    const indexed = await indexFolder(root, { watch: false });
    const result = await findDeadCode(indexed.repo);

    expect(result.coverage.status).toBe("complete");
    expect(result.truncated).toBeUndefined(); // list is short, not cut off
    // `truncated` must never be the carrier of scan incompleteness any more.
    expect(Object.hasOwn(result, "coverage")).toBe(true);
  });
});
