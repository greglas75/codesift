import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCitationCheck, extractLiterals } from "../../scripts/journal-citation-check.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "tests/fixtures/journal/citation-golden.md");
const SCRIPT = join(REPO_ROOT, "scripts/journal-citation-check.ts");

// The check decides whether a cited SHA is real by asking `git log --all`, so it needs actual
// history — and the expected counts below (15/20) are counts of things that resolve against THIS
// repo's commits. The test-farm mirror ships the working tree without `.git`, where every SHA
// looks ungrounded and the whole file failed on an environment gap rather than a defect. Skipping
// where the premise does not hold beats a red suite that everyone learns to ignore.
const hasGitHistory = spawnSync("git", ["cat-file", "-e", "bfa5fce^{commit}"], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
}).status === 0;

describe.skipIf(!hasGitHistory)("journal-citation-check", () => {
  // (a) Golden fixture: 15 grounded / 20 total = 75%
  it("returns 15/20 grounded (75%) for citation-golden.md and passes threshold 70", async () => {
    const result = await runCitationCheck(FIXTURE, 70);
    expect(result.total).toBe(20);
    expect(result.grounded).toBe(15);
    expect(result.percentage).toBeCloseTo(75, 1);
    expect(result.ungrounded).toHaveLength(5);
  });

  // (a) CLI smoke: threshold 70 → exit 0
  it("CLI exits 0 for golden fixture with --threshold 70", () => {
    const proc = spawnSync(
      "npx",
      ["tsx", SCRIPT, FIXTURE, "--threshold", "70"],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    expect(proc.stdout).toContain("Grounded: 15/20 (75.0%)");
    expect(proc.status).toBe(0);
  });

  // (b) File with <80% grounded → fails threshold 80, CLI exits 1
  it("returns <80% and CLI exits 1 when threshold 80 is not met", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "citation-check-"));
    const tmpFile = join(tmp, "low-grounded.md");
    try {
      // 2 real SHAs + 8 fabricated → 2/10 = 20%, well below 80%
      writeFileSync(
        tmpFile,
        [
          "# Low Grounded Entry",
          "",
          "Real: bfa5fce, b718659.",
          "Fake: aaaaaaa, bbbbbbb, ccccccc, ddddddd, eeeeeee, fffffff, 0000000.",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = await runCitationCheck(tmpFile, 80);
      expect(result.percentage).toBeLessThan(80);
      expect(result.grounded).toBe(2);

      const proc = spawnSync(
        "npx",
        ["tsx", SCRIPT, tmpFile, "--threshold", "80"],
        { encoding: "utf-8", cwd: REPO_ROOT },
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // (c) Grammar regex: classifies sha / date / version / plain text
  it("extractLiterals classifies SHA, date, version; ignores plain words", () => {
    const content = [
      "Commit bfa5fce was merged.",
      "Released on 2026-04-21.",
      "Version `v1.2.3` shipped.",
      "Plain words like hello world are ignored.",
    ].join("\n");

    const lits = extractLiterals(content);

    const sha = lits.find((l) => l.literal === "bfa5fce");
    expect(sha).toBeDefined();
    expect(sha?.kind).toBe("sha");

    const date = lits.find((l) => l.literal === "2026-04-21");
    expect(date).toBeDefined();
    expect(date?.kind).toBe("date");

    const version = lits.find((l) => l.literal === "v1.2.3");
    expect(version).toBeDefined();
    expect(version?.kind).toBe("version");

    // plain text words must not appear
    const hasHello = lits.some((l) => l.literal === "hello");
    expect(hasHello).toBe(false);
    const hasWorld = lits.some((l) => l.literal === "world");
    expect(hasWorld).toBe(false);
  });
});
