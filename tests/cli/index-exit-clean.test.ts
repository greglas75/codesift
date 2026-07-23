import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `codesift index` must exit promptly with code 0.
 *
 * Two regressions live here. (1) After an embedding run the process aborted in
 * onnxruntime teardown (exit 134) — fixed by embedding in a child process. (2)
 * terminate()ing a pool worker made it exit code 1, which the exit handler read
 * as a crash and RESPAWNED mid-shutdown; the replacement worker's MessagePort
 * then held the event loop open ~10s until a backstop timer fired. Both surface
 * here as either a non-zero exit or a run that blows the timeout.
 */
const CLI = join(process.cwd(), "dist", "cli.js");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "codesift-exit-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, "src", `f${i}.ts`), `export function f${i}(a: number){ return a * ${i}; }\n`);
  }
  return dir;
}

function runIndex(repo: string, env: Record<string, string>): { code: number; ms: number } {
  const start = Date.now();
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, "index", repo, "--no-watch"], {
      env: { ...process.env, ...env },
      stdio: "ignore",
      timeout: 90_000,
    });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  return { code, ms: Date.now() - start };
}

describe("codesift index — clean, prompt exit", () => {
  it("lite mode (no embeddings) exits 0 without hanging on the worker pool", () => {
    const repo = makeRepo();
    try {
      const { code, ms } = runIndex(repo, { CODESIFT_DISABLE_LOCAL_EMBEDDINGS: "1" });
      expect(code).toBe(0);
      // The respawn-on-shutdown bug made this ~10s (backstop timer). A healthy
      // teardown is well under a second; allow generous slack for CI load.
      expect(ms).toBeLessThan(8_000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with local embeddings exits 0 (no onnxruntime teardown abort)", () => {
    const repo = makeRepo();
    try {
      // Force the local provider on regardless of this machine's RAM auto-lite.
      const { code } = runIndex(repo, { CODESIFT_DISABLE_LOCAL_EMBEDDINGS: "0" });
      expect(code).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);
});
