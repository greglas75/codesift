import { mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, platform, totalmem } from "node:os";
import { join, dirname } from "node:path";
import { isLoopbackHost } from "../utils/loopback.js";
import { writeOwnerOnlyFileSync } from "./owner-only-file.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * `codesift service` — run the shared daemon as a supervised background service.
 *
 * Without this, `codesift serve` is a foreground process: it dies with the
 * terminal that launched it, does not come back after a crash, and is not there
 * after a reboot. Every client is then configured to talk to a daemon that
 * isn't running. Supervision is what makes the shared-daemon model safe to
 * depend on — it turns "one process for everyone" from a single point of
 * failure into a service that restarts itself.
 *
 * macOS gets a per-user LaunchAgent, Linux a systemd *user* unit. Both are
 * per-user and unprivileged by design: nothing here needs root, and a daemon
 * holding every index on the machine is exactly the thing that should not run
 * as root.
 */

export const SERVICE_LABEL = "com.codesift.daemon";
export const DEFAULT_SERVICE_PORT = 7077;

/**
 * PATH handed to the service.
 *
 * launchd does NOT give an agent the login shell's PATH — it gets a minimal
 * one. CodeSift shells out to `git` (repo detection, churn analysis, diff
 * tools) and optionally to `rg`, so a daemon started by launchd with the
 * default PATH silently loses those features while looking healthy. Homebrew
 * differs by arch (/opt/homebrew on Apple Silicon, /usr/local on Intel), so
 * both are listed.
 */
export const SERVICE_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export interface ServicePlan {
  label: string;
  port: number;
  host: string;
  /** Bearer token required for a routable bind; absent for loopback. */
  token?: string;
  /**
   * Extra CODESIFT_* variables baked into the unit.
   *
   * launchd and systemd give a service almost no environment, so anything the
   * daemon needs has to be written into the unit. The embedding provider is the
   * case that forced this: without it the daemon silently falls back to the
   * bundled ONNX runtime and burns the host's CPU, which is exactly what a
   * shared daemon is supposed to stop.
   */
  env?: Record<string, string>;
  /** Absolute path to the node binary that will run the daemon. */
  execPath: string;
  /** Absolute path to the codesift CLI entry point. */
  cliPath: string;
  /** Where the unit file goes. */
  unitPath: string;
  stdoutLog: string;
  stderrLog: string;
  dataDir: string;
}

/** Escape a string for inclusion in XML text content. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * True for addresses that keep the daemon reachable only from this machine.
 *
 * This matters more than it looks: the daemon answers MCP tool calls that read
 * any indexed repository, so binding it to a routable interface publishes the
 * user's entire source tree — and their indexed conversation history — to
 * anything that can reach the port. There is no authentication by default.
 */
export { isLoopbackHost } from "../utils/loopback.js";

/** Resolve the CLI entry point for the currently running codesift install. */
export function resolveCliPath(): string {
  // dist/cli/service.js -> dist/cli.js
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "cli.js");
}

export function buildServicePlan(opts: {
  port?: number;
  host?: string;
  token?: string;
  env?: Record<string, string>;
  dataDir: string;
  execPath?: string;
  cliPath?: string;
  home?: string;
  os?: NodeJS.Platform;
}): ServicePlan {
  const home = opts.home ?? homedir();
  const os = opts.os ?? platform();
  const port = opts.port ?? DEFAULT_SERVICE_PORT;
  const host = opts.host ?? "127.0.0.1";
  const logDir = join(opts.dataDir, "logs");
  const unitPath =
    os === "darwin"
      ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
      : join(home, ".config", "systemd", "user", "codesift-daemon.service");
  return {
    label: SERVICE_LABEL,
    port,
    host,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    execPath: opts.execPath ?? process.execPath,
    cliPath: opts.cliPath ?? resolveCliPath(),
    unitPath,
    stdoutLog: join(logDir, "daemon.out.log"),
    stderrLog: join(logDir, "daemon.err.log"),
    dataDir: opts.dataDir,
  };
}

/**
 * macOS LaunchAgent.
 *
 * `KeepAlive` restarts the daemon whenever it exits for any reason — crash, OOM
 * kill, or a `kill` from a user cleaning up processes. `ThrottleInterval` is the
 * guard that keeps that from becoming a restart storm if the daemon cannot
 * start at all (port taken by something else, corrupt install): launchd waits
 * between attempts instead of spinning. `RunAtLoad` covers login and reboot.
 *
 * To stop it deliberately, unload the agent (`codesift service uninstall`) —
 * killing the process alone just makes launchd start it again, which is the
 * whole point.
 */
/**
 * Heap ceiling for the daemon, in MB.
 *
 * The daemon ran with V8's DEFAULT limit, which is derived from the machine but
 * tops out around 4 GB — on a 128 GB box it was 4288 MB. That is not enough for
 * what this process actually is: one long-lived server for every project on the
 * machine, materialising whole indexes (a 240k-symbol index is ~349 MB resident)
 * and holding two RAM-scaled caches on top. It reached 4.69 GB and died with
 * `FatalProcessOutOfMemory`, launchd restarted it, and it did it again — 14 node
 * crash reports in 24 h on 2026-08-28.
 *
 * The crash loop is the damaging part, not the single crash: an OOM discards ALL
 * in-flight work, so a mass re-index (29 repos rebuilding hash snapshots) never
 * reaches the end, and the next process starts the same work over. Raising the
 * ceiling is what lets that pass finish once.
 *
 * Scaled, not fixed, and CAPPED: a ceiling is also the only thing standing
 * between a genuine leak and the whole machine, so it stays well below total RAM.
 * The cap was 8192 for one afternoon and that was too conservative — a 128 GB
 * workstation running dozens of agents got the same ceiling as a 64 GB one, while
 * the crash it had to prevent happened at 4.7 GB. RAM/8 with a 24 GB cap gives
 * this machine 16 GB: comfortably past the observed peak, still an eighth of the
 * box, and still a bound rather than a blank cheque.
 * `CODESIFT_DAEMON_HEAP_MB` overrides for a machine that needs something else.
 *
 * NOTE this is a ceiling, not a diagnosis. It does not prove the growth is
 * legitimate; it buys the room the observed workload needs and turns a crash loop
 * into a slow pass. If the daemon starts reaching THIS limit too, the answer is
 * the ADR-004 stage-2 work (query the DB instead of materialising indexes), not a
 * bigger number here.
 */
export function resolveDaemonHeapMb(totalRamBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env["CODESIFT_DAEMON_HEAP_MB"]);
  if (Number.isFinite(override) && override >= 512) return Math.floor(override);
  const ramMb = totalRamBytes / (1024 * 1024);
  return Math.min(24576, Math.max(2048, Math.floor(ramMb / 8)));
}

export function buildLaunchAgentPlist(plan: ServicePlan): string {
  // Node options must precede the script path, or node treats them as script args
  // and they are silently ignored — the failure mode being an unchanged limit and
  // a plist that looks correct.
  const heapMb = resolveDaemonHeapMb(totalmem());
  const args = [
    `--max-old-space-size=${heapMb}`,
    plan.cliPath, "serve", "--port", String(plan.port), "--host", plan.host,
  ];
  const argLines = [plan.execPath, ...args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(SERVICE_PATH_ENTRIES.join(":"))}</string>
    <key>CODESIFT_DATA_DIR</key>
    <string>${escapeXml(plan.dataDir)}</string>${Object.entries(plan.env ?? {})
      .map(([k, v]) => `\n    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
      .join("")}${plan.token ? `
    <key>CODESIFT_HTTP_TOKEN</key>
    <string>${escapeXml(plan.token)}</string>` : ""}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(plan.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(plan.stderrLog)}</string>
</dict>
</plist>
`;
}

/**
 * One `Environment=` assignment, quoted so the VALUE cannot become unit syntax.
 *
 * The token was interpolated raw while the macOS path went through `escapeXml`, so the two
 * back-ends disagreed about whether a token is data. Unquoted, whitespace truncates the value; a
 * newline ends the directive and everything after it is parsed as more unit configuration.
 *
 * A newline cannot be represented in a systemd environment value at all, so it is refused rather
 * than mangled — silently dropping part of a credential is worse than failing to install.
 */
export function systemdEnv(key: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      `Refusing to write ${key}: the value contains a newline or NUL, which systemd cannot carry in an Environment= directive.`,
    );
  }
  return `"${key}=${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Linux systemd *user* unit — same supervision contract as the LaunchAgent. */
export function buildSystemdUnit(plan: ServicePlan): string {
  // Same heap ceiling as the LaunchAgent, and for the same reason — see
  // resolveDaemonHeapMb. A Linux host runs the identical workload, so leaving it
  // on V8's default here would just move the crash loop to the other platform.
  const exec = [
    plan.execPath,
    `--max-old-space-size=${resolveDaemonHeapMb(totalmem())}`,
    plan.cliPath, "serve", "--port", String(plan.port), "--host", plan.host,
  ]
    .map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
  return `[Unit]
Description=CodeSift shared MCP daemon
Documentation=https://github.com/greglas75/codesift
After=network.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=10
Environment=PATH=${SERVICE_PATH_ENTRIES.join(":")}
Environment=CODESIFT_DATA_DIR=${plan.dataDir}${Object.entries(plan.env ?? {})
    .map(([k, v]) => `\nEnvironment=${k}=${v}`)
    .join("")}${plan.token ? `\nEnvironment=${systemdEnv("CODESIFT_HTTP_TOKEN", plan.token)}` : ""}
StandardOutput=append:${plan.stdoutLog}
StandardError=append:${plan.stderrLog}

[Install]
WantedBy=default.target
`;
}

export function renderUnit(plan: ServicePlan, os: NodeJS.Platform): string {
  return os === "darwin" ? buildLaunchAgentPlist(plan) : buildSystemdUnit(plan);
}

export interface InstallResult {
  status: "installed" | "already-installed" | "unsupported";
  unitPath: string;
  url: string;
  activated: boolean;
  note?: string;
}

/** Injectable so tests can exercise install/uninstall without touching launchd. */
export type CommandRunner = (cmd: string, args: string[]) => { ok: boolean; message: string };

const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    return { ok: true, message: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    return { ok: false, message: err.stderr?.toString().trim() || err.message || "failed" };
  }
};

/**
 * GUI domain target for launchctl, e.g. `gui/501`.
 *
 * Never guesses. A hardcoded fallback here would aim `bootstrap`/`bootout` at
 * whichever user happens to own that uid — 501 is simply the first account
 * macOS creates, not necessarily this one — so a wrong guess would touch
 * another user's launchd domain. Absent uid means we cannot address a domain
 * at all, and saying so beats acting on a guess.
 */
function guiDomain(): string | null {
  const uid = process.getuid?.();
  return typeof uid === "number" ? `gui/${uid}` : null;
}

export function installService(opts: {
  port?: number;
  host?: string;
  dataDir: string;
  token?: string;
  env?: Record<string, string>;
  force?: boolean;
  os?: NodeJS.Platform;
  home?: string;
  runner?: CommandRunner;
}): InstallResult {
  const run = opts.runner ?? defaultRunner;
  const os = opts.os ?? platform();
  if (os !== "darwin" && os !== "linux") {
    return {
      status: "unsupported",
      unitPath: "",
      url: "",
      activated: false,
      note: `no service integration for ${os} — run 'codesift serve' yourself`,
    };
  }
  const plan = buildServicePlan({ ...opts, ...(opts.os ? { os: opts.os } : {}) });

  // Same rule as the server itself: a routable bind is allowed only with a
  // token, because the token is what turns "publishes every indexed repository"
  // into "serves authenticated callers". Serving several machines from one host
  // is the point of stateless serving; doing it unauthenticated is not.
  if (!isLoopbackHost(plan.host) && !opts.token) {
    throw new Error(
      `refusing to install a service bound to ${plan.host} without a token: the daemon serves `
        + `every indexed repository, so an unauthenticated non-loopback bind publishes your `
        + `source tree. Pass --token (stored in the unit's environment) or use 127.0.0.1.`,
    );
  }

  if (existsSync(plan.unitPath) && opts.force !== true) {
    return {
      status: "already-installed",
      unitPath: plan.unitPath,
      url: `http://${plan.host}:${plan.port}/mcp`,
      activated: false,
      note: "pass --force to overwrite",
    };
  }

  mkdirSync(dirname(plan.unitPath), { recursive: true });
  mkdirSync(join(plan.dataDir, "logs"), { recursive: true });
  // 0600: the rendered unit embeds CODESIFT_HTTP_TOKEN, and a service file is
  // world-readable by default — on the shared host this feature exists for, that
  // hands the daemon credential to every other local account. Raises instead of
  // installing a unit whose permissions it could not set; this is the exact file
  // that was found at -rw-r--r-- on burst-i9.
  writeOwnerOnlyFileSync(plan.unitPath, renderUnit(plan, os));

  let activated = false;
  let note: string | undefined;
  if (os === "darwin") {
    const domain = guiDomain();
    if (!domain) {
      note = "unit written, but this process has no uid — activate with "
        + `launchctl bootstrap gui/$(id -u) ${plan.unitPath}`;
    } else {
      // `bootout` on a label that is not loaded is a normal no-op, so its
      // failure is not an error — it exists to replace a previous registration.
      run("launchctl", ["bootout", `${domain}/${plan.label}`]);
      const r = run("launchctl", ["bootstrap", domain, plan.unitPath]);
      activated = r.ok;
      if (!r.ok) note = `unit written, but launchctl bootstrap failed: ${r.message}`;
    }
  } else {
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", "codesift-daemon.service"]);
    activated = r.ok;
    if (!r.ok) note = `unit written, but systemctl enable failed: ${r.message}`;
  }

  return {
    status: "installed",
    unitPath: plan.unitPath,
    url: `http://${plan.host}:${plan.port}/mcp`,
    activated,
    ...(note ? { note } : {}),
  };
}

export function uninstallService(opts: {
  dataDir: string;
  os?: NodeJS.Platform;
  home?: string;
  runner?: CommandRunner;
}): { status: "removed" | "not-installed"; unitPath: string } {
  const run = opts.runner ?? defaultRunner;
  const os = opts.os ?? platform();
  const plan = buildServicePlan({ ...opts, ...(opts.os ? { os: opts.os } : {}) });
  const existed = existsSync(plan.unitPath);
  if (os === "darwin") {
    const domain = guiDomain();
    if (domain) run("launchctl", ["bootout", `${domain}/${plan.label}`]);
  } else {
    run("systemctl", ["--user", "disable", "--now", "codesift-daemon.service"]);
  }
  if (existed) {
    try { unlinkSync(plan.unitPath); } catch { /* best-effort */ }
  }
  return { status: existed ? "removed" : "not-installed", unitPath: plan.unitPath };
}

/**
 * Installed / starting / running, kept distinct on purpose.
 *
 * The daemon writes `daemon.pid` when it takes the lock but `daemon.port` only
 * once the HTTP listener is actually up, and on a machine with large indexes
 * that gap is tens of seconds. Collapsing the gap into "running" reports a
 * daemon nothing can connect to yet as healthy, which sends whoever is
 * debugging a client straight past the real answer ("wait, then retry").
 */
export function serviceStatus(opts: { dataDir: string; os?: NodeJS.Platform; home?: string }): {
  installed: boolean;
  unitPath: string;
  state: "not-installed" | "stopped" | "starting" | "running";
  running: boolean;
  pid: number | null;
  port: number | null;
} {
  const plan = buildServicePlan({ ...opts, ...(opts.os ? { os: opts.os } : {}) });
  const installed = existsSync(plan.unitPath);
  let pid: number | null = null;
  let port: number | null = null;
  try {
    pid = parseInt(readFileSync(join(opts.dataDir, "daemon.pid"), "utf-8").trim(), 10);
    port = parseInt(readFileSync(join(opts.dataDir, "daemon.port"), "utf-8").trim(), 10);
  } catch { /* no lock — not running */ }
  let running = false;
  if (pid !== null && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch (e) {
      running = (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  const hasPort = port !== null && Number.isInteger(port) && port > 0;
  const state = !installed && !running
    ? "not-installed"
    : running
      ? (hasPort ? "running" : "starting")
      : "stopped";
  return {
    installed,
    unitPath: plan.unitPath,
    state,
    running: state === "running",
    pid: running ? pid : null,
    port: state === "running" ? port : null,
  };
}
