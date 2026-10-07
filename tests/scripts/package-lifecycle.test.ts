import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// npm runs lifecycle scripts through cmd.exe on Windows. `2>/dev/null` there is "The system cannot
// find the path specified", the script exits 1, and npm rolls back the whole `npm install -g`.
// Scripts that run on a USER's machine must therefore be a bare `node <file>`.
const USER_LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

describe("package.json lifecycle scripts run under cmd.exe", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> };

  it("postinstall is a plain Node invocation of a published file", () => {
    expect(pkg.scripts.postinstall).toBe("node ./postinstall.mjs");
    expect((pkg as unknown as { files: string[] }).files).toContain("postinstall.mjs");
  });

  // `npm ci` in a clone runs postinstall before any build exists; failing there broke every fresh
  // checkout, CI and the test farm (the shell version survived it through `|| true`).
  it("postinstall exits 0 when dist/ has not been built", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-postinstall-"));
    try {
      copyFileSync("postinstall.mjs", join(dir, "postinstall.mjs"));
      const run = spawnSync(process.execPath, [join(dir, "postinstall.mjs")], { encoding: "utf-8" });
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(USER_LIFECYCLE)("%s has no POSIX-only shell syntax", (name) => {
    const script = pkg.scripts[name];
    if (script === undefined) return;
    expect(script).not.toMatch(/\/dev\/null|;|&&|\|\||\$\(|`|\b2>/);
  });
});
