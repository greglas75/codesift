#!/usr/bin/env node
/**
 * Restart the supervised daemon after a build, if one is running from THIS tree.
 *
 * `npm run build` opens with `rmSync('dist')`, and the daemon (`codesift service install`)
 * executes `dist/cli.js`. A routine build therefore deletes the code a machine-wide service is
 * running from. Node keeps serving from the modules it already resolved, so nothing looks wrong —
 * until the first LAZILY imported module resolves against the new files and fails with a message
 * that reads like a source bug rather than an operational one. Measured 2026-08-04: every tool
 * call through the daemon failed that way while `/health` still answered 200.
 *
 * The supervisor already knows how to restart it. Nobody was telling it to.
 *
 * Rules this script follows, because it runs on every build including CI and other people's
 * machines:
 *   - never fail the build (always exit 0),
 *   - do nothing when no supervised daemon exists,
 *   - do nothing when the running daemon is NOT executing this checkout's dist — restarting
 *     someone else's daemon because we happened to compile is worse than the bug.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const LABEL = "com.codesift.daemon";

function quiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function main() {
  if (process.platform !== "darwin") {
    // Linux uses a systemd user unit; same idea, but this machine class is where the daemon
    // actually runs today. Left explicit rather than silently pretending to have handled it.
    const active = quiet("systemctl", ["--user", "is-active", "codesift-daemon.service"]);
    if (active && active.trim() === "active") {
      quiet("systemctl", ["--user", "restart", "codesift-daemon.service"]);
      console.log("[build] restarted codesift-daemon.service (it was running this dist)");
    }
    return;
  }

  const uid = process.getuid?.();
  if (uid === undefined) return;

  const printed = quiet("launchctl", ["print", `gui/${uid}/${LABEL}`]);
  if (!printed) return; // no supervised daemon on this machine — nothing to do

  // Only ours. `launchctl print` lists the unit's argv; if it does not point at this checkout's
  // dist, another install owns it and we keep our hands off.
  if (!printed.includes(DIST)) {
    console.log(`[build] ${LABEL} is running from another install — left alone`);
    return;
  }

  quiet("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
  console.log(`[build] restarted ${LABEL} — it was executing the dist this build just replaced`);
}

try {
  main();
} catch {
  /* never fail a build over this */
}
process.exit(0);
