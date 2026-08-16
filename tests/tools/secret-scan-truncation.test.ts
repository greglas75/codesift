// `scan_secrets` capped at 200 findings and said nothing. For a security tool that is the one
// misreading that matters: a repo with 500 leaked keys reported the same number as a repo with
// exactly 200, and nothing in the response told them apart. Measured on this repo at
// min_confidence "low": 200 shown, 29,371 matched — 99.3% hidden, silently.
//
// Truncating is fine. Truncating without saying so turns "we found 200" into "there are 200".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFolder } from "../../src/tools/index-tools/folder-indexer.js";
import { scanSecrets } from "../../src/tools/secret-tools.js";
import { resetConfigCache } from "../../src/config.js";

let dataDir: string;
let repo: string;
let repoName: string;
let prevData: string | undefined;

beforeEach(async () => {
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-sec-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  repo = mkdtempSync(join(tmpdir(), "cs-sec-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // Several files, each with an unmistakable AWS-shaped key, so there is more than one finding.
  // Real-shaped values: AWS access keys are AKIA + 16 uppercase alphanumerics (20 total). A
  // wrong-length placeholder matches nothing, which is how the first version of this test
  // "passed" against zero findings.
  const ids = ["3T7VZQ2XKLMN9WPD", "5R2QWE8YTMBN4KXC", "7HJ4LP0VNMQZ2WTD",
               "9BXCV3NMQ8LKJH2A", "2QWZ7XSC4RFV9TGB", "6YHN3UJM8IKO5PLQ"];
  for (let i = 0; i < ids.length; i++) {
    writeFileSync(
      join(repo, "src", `leak${i}.ts`),
      `export const AWS_ACCESS_KEY_ID = "AKIA${ids[i]}";\n`,
    );
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
  const indexed = await indexFolder(repo, { watch: false });
  repoName = indexed.repo;
});

afterEach(() => {
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  resetConfigCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("scan_secrets truncation is reported", () => {
  it("says how many it hid, not just how many it showed", async () => {
    const capped = await scanSecrets(repoName, {
      min_confidence: "low",
      exclude_tests: false,
      max_results: 2,
    });

    expect(capped.findings.length).toBe(2);
    expect(capped.truncated).toBe(true);
    expect(capped.total_findings).toBeGreaterThan(2);
    // The hint has to say the remainder is NOT clean — "showing 2" invites exactly that reading.
    expect(capped.hint).toMatch(/NOT clean/);
  }, 60_000);

  it("stays silent when nothing was hidden", async () => {
    // A truncation field present on every response is noise, and noise gets ignored — so absence
    // must be a real signal that `findings` is everything that matched.
    const full = await scanSecrets(repoName, {
      min_confidence: "low",
      exclude_tests: false,
      max_results: 10_000,
    });

    expect("truncated" in full).toBe(false);
    expect("total_findings" in full).toBe(false);
  }, 60_000);

  it("reports a total that matches what an uncapped scan returns", async () => {
    // The number has to be the real one, not the cap plus a guess.
    const capped = await scanSecrets(repoName, { min_confidence: "low", exclude_tests: false, max_results: 1 });
    const full = await scanSecrets(repoName, { min_confidence: "low", exclude_tests: false, max_results: 10_000 });
    expect(capped.total_findings).toBe(full.findings.length);
  }, 60_000);
});
