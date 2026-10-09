#!/usr/bin/env node
// ONE-TIME owner step (docs/release-native.md): publish a 0.0.0 placeholder of every @codesift/core-*
// platform package, so each can be given a trusted publisher on npmjs.com. npm only lets a trusted
// publisher be configured for a package that already exists, and the release workflow publishes
// through OIDC — so the very first version has to come from a logged-in owner.
//
//   npm login                                        # an owner of the @codesift org, with 2FA
//   node scripts/bootstrap-native-packages.mjs [--dry-run]
//
// The placeholders carry no binary; codesift-mcp never depends on 0.0.0 (the release workflow pins
// optionalDependencies to the version it just published), so they are never installed by anyone.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
let failed = 0;

for (const tag of readdirSync(join(root, "npm")).sort()) {
  const src = join(root, "npm", tag);
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  const work = mkdtempSync(join(tmpdir(), `codesift-bootstrap-${tag}-`));
  try {
    const placeholder = { ...pkg, version: "0.0.0", files: ["README.md"] };
    delete placeholder.main;
    writeFileSync(join(work, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
    copyFileSync(join(src, "README.md"), join(work, "README.md"));
    const args = ["publish", "--access", "public", ...(dryRun ? ["--dry-run"] : [])];
    const r = spawnSync("npm", args, { cwd: work, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status === 0) console.log(`placeholder published: ${pkg.name}@0.0.0`);
    else {
      failed++;
      console.error(`FAILED: ${pkg.name} (npm publish exited ${r.status})`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed === 0 ? 0 : 1);
