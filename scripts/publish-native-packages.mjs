#!/usr/bin/env node
// Release step for the native core's platform packages (ADR-006). Run by .github/workflows/release.yml
// after the build matrix, BEFORE the main package is published:
//
//   node scripts/publish-native-packages.mjs --artifacts <dir> [--dry-run]
//
// For each platform under npm/: copy codesift-core.<tag>.node out of <dir> (download-artifact puts each
// build in <dir>/native-<tag>/), stamp the main package's version, `npm publish` it. Then write
// `optionalDependencies` into the main package.json — ONLY for the platforms that actually published.
//
// Why injected here and never committed: an optionalDependency pinned to a version that does not
// exist yet makes `npm ci` resolve against the registry for every developer and every CI run before
// the release. And why only the successes: a platform package that failed to publish (no binary built,
// trusted publisher not configured yet) must leave the main package installable — users of that
// platform get the TypeScript path, exactly as before the core existed.
//
// Exit 0 when the main package can be published (even if some platforms were skipped); non-zero only on
// a usage error.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** True when `name@version` is already on the registry — a re-run of a release that got that far. */
function alreadyPublished(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return r.status === 0 && r.stdout.trim() === version;
}

function main() {
  const artifacts = arg("--artifacts");
  const dryRun = process.argv.includes("--dry-run");
  if (!artifacts) {
    console.error("usage: publish-native-packages.mjs --artifacts <dir> [--dry-run]");
    process.exit(2);
  }
  const mainPkgPath = join(root, "package.json");
  const mainPkg = readJson(mainPkgPath);
  const version = mainPkg.version;

  const published = [];
  const skipped = [];
  for (const tag of readdirSync(join(root, "npm")).sort()) {
    const dir = join(root, "npm", tag);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const name = readJson(pkgPath).name;
    // npm refuses to publish over an existing version, so on a re-run (the main publish failed after
    // the platforms went out) every platform would land in `skipped` and the main package would ship
    // with NO native dependencies. What is on the registry counts as published.
    if (!dryRun && alreadyPublished(name, version)) {
      published.push(name);
      continue;
    }
    const file = `codesift-core.${tag}.node`;
    const built = [join(artifacts, `native-${tag}`, file), join(artifacts, file)].find(existsSync);
    if (!built) {
      skipped.push(`${tag}: no binary in ${artifacts}`);
      continue;
    }
    // Assembled in a scratch directory, so the templates under npm/ are never modified — not even by a
    // local --dry-run.
    const work = mkdtempSync(join(tmpdir(), `codesift-native-${tag}-`));
    try {
      const pkg = readJson(pkgPath);
      pkg.version = version;
      writeJson(join(work, "package.json"), pkg);
      copyFileSync(join(dir, "README.md"), join(work, "README.md"));
      copyFileSync(built, join(work, file));
      const args = ["publish", "--access", "public", "--ignore-scripts", ...(dryRun ? ["--dry-run"] : [])];
      const r = spawnSync("npm", args, { cwd: work, stdio: "inherit", shell: process.platform === "win32" });
      if (r.status === 0) {
        published.push(pkg.name);
      } else {
        skipped.push(`${tag}: npm publish exited ${r.status ?? r.error?.message}`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Recomputed, not merged: a platform that did not make it this time must not keep a pin from an
  // earlier write. Other optional dependencies are left as they are.
  const optional = Object.fromEntries(
    Object.entries(mainPkg.optionalDependencies ?? {}).filter(([n]) => !n.startsWith("@codesift/core-")),
  );
  for (const name of published) optional[name] = version;
  if (Object.keys(optional).length > 0) mainPkg.optionalDependencies = optional;
  else delete mainPkg.optionalDependencies;
  if (!dryRun) writeJson(mainPkgPath, mainPkg);

  console.log(`native packages published: ${published.length ? published.join(", ") : "none"}`);
  for (const s of skipped) console.log(`native package skipped — ${s}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      "### Native platform packages",
      "",
      ...published.map((n) => `- published \`${n}@${version}\``),
      ...skipped.map((s) => `- **skipped** ${s} — users on that platform get the TypeScript path`),
      "",
    ];
    writeFileSync(summary, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

main();
