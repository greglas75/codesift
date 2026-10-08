/**
 * The daemon indexes in a child process (out-of-process.ts). These pin the contract the daemon
 * relies on: the child's index is the SAME index the in-process path writes, the daemon's resident
 * copies are dropped afterwards, concurrent identical requests share one child, and a child that
 * fails surfaces as a failure — never as an empty success.
 *
 * Runs the real child (src/cli/index-child.ts through tsx), not a mock: what can break here is the
 * process boundary itself — argv, env, the marker line, the exit path.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, getCodeIndex } from "../../src/tools/index-tools.js";
import { codeIndexes } from "../../src/tools/index-tools/state.js";
import {
  enableOutOfProcessIndexing,
  shouldIndexOutOfProcess,
} from "../../src/tools/index-tools/out-of-process.js";
import type { CodeIndex } from "../../src/types.js";

const CHILD_TIMEOUT_MS = 90_000;

async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(join(root, "src", "lib", "math.ts"), [
    "export function add(a: number, b: number): number { return a + b; }",
    "export function mul(a: number, b: number): number { return a * b; }",
    "export class Calculator {",
    "  total = 0;",
    "  push(n: number): this { this.total = add(this.total, n); return this; }",
    "}",
  ].join("\n"));
  await writeFile(join(root, "src", "index.ts"), [
    'import { add, Calculator } from "./lib/math";',
    "export const answer = add(40, 2);",
    "export function makeCalculator(): Calculator { return new Calculator(); }",
  ].join("\n"));
  await writeFile(join(root, "README.md"), "# fixture\n\n## Usage\n\nCall add.\n");
}

describe("indexFolder out of process", () => {
  let scratch: string;
  const savedEnv = process.env["CODESIFT_INDEX_OUT_OF_PROCESS"];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "codesift-oop-"));
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["CODESIFT_INDEX_OUT_OF_PROCESS"];
    else process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = savedEnv;
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("is off by default, on for a daemon, and the env wins either way", () => {
    delete process.env["CODESIFT_INDEX_OUT_OF_PROCESS"];
    expect(shouldIndexOutOfProcess()).toBe(false);
    const undo = enableOutOfProcessIndexing();
    try {
      expect(shouldIndexOutOfProcess()).toBe(true);
      process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "0";
      expect(shouldIndexOutOfProcess()).toBe(false);
    } finally {
      undo();
      undo(); // idempotent: a double close must not switch off another daemon's opt-in
    }
    delete process.env["CODESIFT_INDEX_OUT_OF_PROCESS"];
    expect(shouldIndexOutOfProcess()).toBe(false);
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "1";
    expect(shouldIndexOutOfProcess()).toBe(true);
  });

  it("writes the same index the in-process path writes, and drops the resident copy", async () => {
    const inprocRoot = join(scratch, "inproc");
    const childRoot = join(scratch, "child");
    await writeFixture(inprocRoot);
    await cp(inprocRoot, childRoot, { recursive: true });

    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "0";
    const inproc = await indexFolder(inprocRoot, { watch: false });

    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "1";
    // A resident copy the daemon would otherwise go on serving after the child replaced the index.
    const stale = { repo: "x", symbols: [], files: [] } as unknown as CodeIndex;
    const childRepoGuess = inproc.repo.replace(/inproc$/, "child");
    codeIndexes.set(childRepoGuess, stale);

    const child = await indexFolder(childRoot, { watch: false });
    expect(child.repo).toBe(childRepoGuess);
    expect(child.file_count).toBe(inproc.file_count);
    expect(child.symbol_count).toBe(inproc.symbol_count);
    expect(child.symbol_count).toBeGreaterThan(0);
    expect(codeIndexes.get(child.repo)).toBeUndefined();

    // The registry entry and the stored symbols are what every later tool call reads.
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "0";
    const stored = await getCodeIndex(child.repo, { skipFreshness: true });
    expect(stored?.symbols.length).toBe(child.symbol_count);
    const names = new Set(stored?.symbols.map((s) => s.name));
    for (const n of ["add", "mul", "Calculator", "makeCalculator"]) expect(names.has(n)).toBe(true);
    // Symbol ids name the child's repo, not something the child process invented.
    expect(stored?.symbols.every((s) => s.id.startsWith(`${child.repo}:`))).toBe(true);
  }, CHILD_TIMEOUT_MS);

  it("concurrent identical requests share ONE child run", async () => {
    const root = join(scratch, "coalesce");
    await writeFixture(root);
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "1";
    // `incremental` differs, and is not part of the key: indexFolder never reads it.
    const [a, b] = await Promise.all([
      indexFolder(root, { watch: false }),
      indexFolder(root, { watch: false, incremental: true }),
    ]);
    expect(a).toBe(b);
    expect(a.file_count).toBeGreaterThan(0);
  }, CHILD_TIMEOUT_MS);

  // A wedged child must fail its run (runs for one root are chained, so a hang parked the repo),
  // and a failed run must still drop resident copies: the child may have committed before failing.
  it("kills a child that outlives its timeout, fails the run, and drops the resident copy", async () => {
    const root = join(scratch, "timeout");
    await writeFixture(root);
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "0";
    const { repo } = await indexFolder(root, { watch: false });
    codeIndexes.set(repo, { repo, symbols: [], files: [] } as unknown as CodeIndex);

    const savedTimeout = process.env["CODESIFT_INDEX_CHILD_TIMEOUT_MS"];
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "1";
    process.env["CODESIFT_INDEX_CHILD_TIMEOUT_MS"] = "1";
    try {
      await expect(indexFolder(root, { watch: false, force: true })).rejects.toThrow(/killed after 1 ms/);
    } finally {
      if (savedTimeout === undefined) delete process.env["CODESIFT_INDEX_CHILD_TIMEOUT_MS"];
      else process.env["CODESIFT_INDEX_CHILD_TIMEOUT_MS"] = savedTimeout;
    }
    expect(codeIndexes.get(repo)).toBeUndefined();
  }, CHILD_TIMEOUT_MS);

  it("reports the outcome the in-process path reports for a path that cannot be indexed", async () => {
    const missing = join(scratch, "does-not-exist");
    const outcome = async (): Promise<string> => {
      try {
        const r = await indexFolder(missing, { watch: false });
        return `ok:${r.file_count}:${r.symbol_count}`;
      } catch (err) {
        return `error:${(err as Error).message}`;
      }
    };
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "0";
    const inproc = await outcome();
    process.env["CODESIFT_INDEX_OUT_OF_PROCESS"] = "1";
    const child = await outcome();
    expect(child).toBe(inproc);
  }, CHILD_TIMEOUT_MS);
});
