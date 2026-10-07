import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// npm runs lifecycle scripts through cmd.exe on Windows. `2>/dev/null` there is "The system cannot
// find the path specified", the script exits 1, and npm rolls back the whole `npm install -g`.
// Scripts that run on a USER's machine must therefore be a bare `node <file>`.
const USER_LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

describe("package.json lifecycle scripts run under cmd.exe", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> };

  it("postinstall is a plain Node invocation", () => {
    expect(pkg.scripts.postinstall).toBe("node ./dist/postinstall.js");
  });

  it.each(USER_LIFECYCLE)("%s has no POSIX-only shell syntax", (name) => {
    const script = pkg.scripts[name];
    if (script === undefined) return;
    expect(script).not.toMatch(/\/dev\/null|;|&&|\|\||\$\(|`|\b2>/);
  });
});
