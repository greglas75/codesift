#!/usr/bin/env node
// Build the Rust core (crates/codesift-napi) and place it where src/native/index.ts looks first:
// native/codesift-core.<platform-tag>.node
//
// Separate from `npm run build` on purpose: the TypeScript build must keep working on machines
// and CI jobs without a Rust toolchain — the core is optional (ADR-006).
//
// Usage: node scripts/build-native.mjs [--debug] [--target x86_64-apple-darwin]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy of `platformTag` in src/native/index.ts (that one needs dist/); a test holds them equal. */
export function platformTag(platform = process.platform, arch = process.arch, isMusl = detectMusl) {
  switch (platform) {
    case "darwin":
      return arch === "arm64" || arch === "x64" ? `darwin-${arch}` : null;
    case "win32":
      return arch === "x64" || arch === "arm64" ? `win32-${arch}-msvc` : null;
    case "linux":
      if (arch !== "x64" && arch !== "arm64") return null;
      return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
    default:
      return null;
  }
}

function detectMusl() {
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    return false;
  }
}

/** File name cargo gives a cdylib named `codesift_napi` on each platform. */
export function cdylibName(platform = process.platform) {
  if (platform === "win32") return "codesift_napi.dll";
  if (platform === "darwin") return "libcodesift_napi.dylib";
  return "libcodesift_napi.so";
}

/** `--name value` from argv. */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/**
 * Cross-compilation targets the release matrix builds on a runner of another architecture
 * (`--target x86_64-apple-darwin` on an Apple-silicon runner). The tag names the output file and the
 * platform package; the platform decides the cdylib's file name.
 */
const CROSS_TARGETS = {
  "x86_64-apple-darwin": { tag: "darwin-x64", platform: "darwin" },
  "aarch64-apple-darwin": { tag: "darwin-arm64", platform: "darwin" },
};

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const debug = process.argv.includes("--debug");
  const target = arg("--target");
  const cross = target ? CROSS_TARGETS[target] : undefined;
  if (target && !cross) {
    console.error(`build-native: unsupported --target ${target} (known: ${Object.keys(CROSS_TARGETS).join(", ")})`);
    process.exit(2);
  }
  const tag = cross ? cross.tag : platformTag();
  if (!tag) {
    console.error(`build-native: no napi target for ${process.platform}-${process.arch}`);
    process.exit(2);
  }

  const args = ["build", "-p", "codesift-napi", ...(debug ? [] : ["--release"]), ...(target ? ["--target", target] : [])];
  const r = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
  if (r.error) {
    console.error(`build-native: cannot run cargo (${r.error.message}) — install Rust 1.99.0, see rust-toolchain.toml`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);

  const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "target");
  const profileDir = target ? join(targetDir, target, debug ? "debug" : "release") : join(targetDir, debug ? "debug" : "release");
  const built = join(profileDir, cdylibName(cross ? cross.platform : process.platform));
  if (!existsSync(built)) {
    console.error(`build-native: cargo succeeded but ${built} is missing`);
    process.exit(1);
  }
  const out = join(root, "native", `codesift-core.${tag}.node`);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(built, out);
  console.log(`build-native: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
