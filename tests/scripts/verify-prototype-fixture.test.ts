import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(REPO_ROOT, "scripts/verify-prototype-fixture.sh");
const PROTOTYPE = join(REPO_ROOT, ".codesift/wiki/history.md");

describe("verify-prototype-fixture.sh", () => {
  it("Case 1 (match): exits 0 when fixture is byte-identical to prototype", () => {
    if (!existsSync(PROTOTYPE)) {
      console.warn(`Skipping: prototype file not found at ${PROTOTYPE}`);
      return;
    }
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it("Case 2 (drift): exits 1 with recognizable message when file differs", () => {
    if (!existsSync(PROTOTYPE)) {
      console.warn(`Skipping: prototype file not found at ${PROTOTYPE}`);
      return;
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "codesift-drift-"));
    const driftedPath = join(tmpDir, "drifted.md");
    try {
      copyFileSync(PROTOTYPE, driftedPath);
      appendFileSync(driftedPath, "\nDRIFT\n");

      const result = spawnSync("bash", [SCRIPT, PROTOTYPE, driftedPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });

      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);

      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).toMatch(/SHA mismatch/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
