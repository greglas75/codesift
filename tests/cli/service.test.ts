import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDaemonHeapMb,
  buildServicePlan,
  buildLaunchAgentPlist,
  buildSystemdUnit,
  escapeXml,
  isLoopbackHost,
  installService,
  uninstallService,
  serviceStatus,
  SERVICE_PATH_ENTRIES,
  SERVICE_LABEL,
  type CommandRunner,
} from "../../src/cli/service.js";

let home: string;
let dataDir: string;
let calls: Array<[string, string[]]>;
const okRunner: CommandRunner = (cmd, args) => {
  calls.push([cmd, args]);
  return { ok: true, message: "" };
};

const PLAN_OPTS = { execPath: "/usr/local/bin/node", cliPath: "/opt/codesift/dist/cli.js" };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codesift-svc-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "codesift-svc-data-"));
  calls = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("service — unit generation", () => {
  it("puts the LaunchAgent in the user's own LaunchAgents dir, never a system one", () => {
    const plan = buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS });
    expect(plan.unitPath).toBe(join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`));
    // A daemon holding every index on the machine must not be a system-wide,
    // root-owned service.
    expect(plan.unitPath).not.toContain("/Library/LaunchDaemons");
  });

  it("puts the systemd unit under the user scope on Linux", () => {
    const plan = buildServicePlan({ dataDir, home, os: "linux", ...PLAN_OPTS });
    expect(plan.unitPath).toBe(
      join(home, ".config", "systemd", "user", "codesift-daemon.service"),
    );
  });

  it("supervises: restarts on exit, starts at login, and throttles restart storms", () => {
    const plist = buildLaunchAgentPlist(
      buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
    );
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    // Without a throttle, a daemon that cannot bind its port at all would be
    // respawned in a tight loop by launchd.
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/);
  });

  it("gives systemd the same contract", () => {
    const unit = buildSystemdUnit(buildServicePlan({ dataDir, home, os: "linux", ...PLAN_OPTS }));
    expect(unit).toContain("Restart=always");
    expect(unit).toMatch(/RestartSec=\d+/);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("hardcodes no paths — the running install's node and CLI are baked in", () => {
    const plist = buildLaunchAgentPlist(
      buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
    );
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/codesift/dist/cli.js</string>");
    // No author-machine leftovers.
    expect(plist).not.toContain("/Users/greglas");
  });

  it("carries a PATH that can still find git, on both Homebrew layouts", () => {
    // launchd hands an agent a minimal PATH, so without this the daemon loses
    // git-backed features (churn, diff, repo detection) while looking healthy.
    const plist = buildLaunchAgentPlist(
      buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
    );
    expect(plist).toContain("<key>PATH</key>");
    expect(SERVICE_PATH_ENTRIES).toContain("/opt/homebrew/bin"); // Apple Silicon
    expect(SERVICE_PATH_ENTRIES).toContain("/usr/local/bin"); // Intel
    expect(SERVICE_PATH_ENTRIES).toContain("/usr/bin");
  });

  it("pins the data dir so the service does not depend on an inherited env", () => {
    const plist = buildLaunchAgentPlist(
      buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
    );
    expect(plist).toContain("<key>CODESIFT_DATA_DIR</key>");
    expect(plist).toContain(`<string>${dataDir}</string>`);
  });

  it("escapes XML metacharacters in paths instead of emitting a broken plist", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
    const plan = buildServicePlan({
      dataDir: "/tmp/we<ird>&co",
      home,
      os: "darwin",
      ...PLAN_OPTS,
    });
    const plist = buildLaunchAgentPlist(plan);
    expect(plist).toContain("/tmp/we&lt;ird&gt;&amp;co");
    expect(plist).not.toContain("<ird>");
  });
});

describe("service — network exposure", () => {
  it("recognises only loopback addresses", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", " 127.0.0.1 ", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.10", "::", "example.com"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it("refuses to install a service reachable from the network", () => {
    // The daemon answers tool calls that read any indexed repo and has no auth
    // by default — a routable bind publishes the user's whole source tree.
    expect(() =>
      installService({ dataDir, home, os: "darwin", host: "0.0.0.0", runner: okRunner }),
    ).toThrow(/refusing/i);
    expect(calls).toHaveLength(0);
  });
});

describe("service — install / uninstall", () => {
  it("writes and activates the unit", async () => {
    const res = installService({ dataDir, home, os: "darwin", port: 7077, runner: okRunner });
    expect(res.status).toBe("installed");
    expect(res.activated).toBe(true);
    expect(res.url).toBe("http://127.0.0.1:7077/mcp");
    await expect(readFile(res.unitPath, "utf-8")).resolves.toContain("<key>KeepAlive</key>");
    expect(calls.some(([c, a]) => c === "launchctl" && a[0] === "bootstrap")).toBe(true);
  });

  it("does not clobber an existing unit unless forced", async () => {
    const plan = buildServicePlan({ dataDir, home, os: "darwin" });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plan.unitPath, "PRE-EXISTING", "utf-8");

    const res = installService({ dataDir, home, os: "darwin", runner: okRunner });
    expect(res.status).toBe("already-installed");
    await expect(readFile(plan.unitPath, "utf-8")).resolves.toBe("PRE-EXISTING");
    expect(calls).toHaveLength(0);

    const forced = installService({ dataDir, home, os: "darwin", force: true, runner: okRunner });
    expect(forced.status).toBe("installed");
    await expect(readFile(plan.unitPath, "utf-8")).resolves.toContain("<plist");
  });

  it("reports activation failure instead of claiming success", () => {
    const failing: CommandRunner = (cmd, args) => {
      calls.push([cmd, args]);
      return args[0] === "bootstrap" ? { ok: false, message: "boom" } : { ok: true, message: "" };
    };
    const res = installService({ dataDir, home, os: "darwin", runner: failing });
    expect(res.status).toBe("installed");
    expect(res.activated).toBe(false);
    expect(res.note).toMatch(/bootstrap failed/);
  });

  it("uninstall deactivates and removes, and is safe to repeat", () => {
    installService({ dataDir, home, os: "darwin", runner: okRunner });
    const first = uninstallService({ dataDir, home, os: "darwin", runner: okRunner });
    expect(first.status).toBe("removed");
    const second = uninstallService({ dataDir, home, os: "darwin", runner: okRunner });
    expect(second.status).toBe("not-installed");
  });

  it("declines unknown platforms rather than writing a unit nothing reads", () => {
    const res = installService({ dataDir, home, os: "win32", runner: okRunner });
    expect(res.status).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("service — status", () => {
  it("reports not-running when no daemon lock exists", () => {
    const s = serviceStatus({ dataDir, home, os: "darwin" });
    expect(s.installed).toBe(false);
    expect(s.state).toBe("not-installed");
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });

  it("distinguishes a daemon still booting from one that is serving", async () => {
    // The lock is taken before the HTTP listener is up, and on a machine with
    // large indexes that gap is tens of seconds. Reporting it as "running"
    // would tell someone debugging a client that the daemon is fine when
    // nothing can connect to it yet.
    await writeFile(join(dataDir, "daemon.pid"), String(process.pid), "utf-8");
    const booting = serviceStatus({ dataDir, home, os: "darwin" });
    expect(booting.state).toBe("starting");
    expect(booting.running).toBe(false);
    expect(booting.port).toBeNull();

    await writeFile(join(dataDir, "daemon.port"), "7077", "utf-8");
    const up = serviceStatus({ dataDir, home, os: "darwin" });
    expect(up.state).toBe("running");
    expect(up.running).toBe(true);
    expect(up.port).toBe(7077);
  });

  it("treats a stale lock from a dead process as not running", async () => {
    // A daemon killed with -9 leaves its lock behind; reporting that as running
    // would tell the user everything is fine while every client is failing.
    await writeFile(join(dataDir, "daemon.pid"), "999999", "utf-8");
    await writeFile(join(dataDir, "daemon.port"), "7077", "utf-8");
    const s = serviceStatus({ dataDir, home, os: "darwin" });
    expect(s.running).toBe(false);
    expect(s.pid).toBeNull();
  });

  it("reports running for a live process", async () => {
    await writeFile(join(dataDir, "daemon.pid"), String(process.pid), "utf-8");
    await writeFile(join(dataDir, "daemon.port"), "7077", "utf-8");
    const s = serviceStatus({ dataDir, home, os: "darwin" });
    expect(s.state).toBe("running");
    expect(s.running).toBe(true);
    expect(s.pid).toBe(process.pid);
    expect(s.port).toBe(7077);
  });
});

/**
 * The daemon ran on V8's DEFAULT heap limit — 4288 MB on a 128 GB machine — while
 * being one long-lived server for every project, materialising whole indexes. It
 * reached 4.69 GB, died with `FatalProcessOutOfMemory`, and launchd restarted it
 * into the same wall: 14 node crash reports in 24 h (2026-08-28).
 *
 * The loop is what does the damage. An OOM discards all in-flight work, so a mass
 * re-index never reaches the end and the next process repeats it.
 */
describe("service — daemon heap ceiling", () => {
  const GB = 1024 ** 3;

  it("scales with machine RAM instead of taking V8's default", () => {
    expect(resolveDaemonHeapMb(32 * GB, {})).toBe(4096);
    expect(resolveDaemonHeapMb(128 * GB, {})).toBe(16384);
  });

  it("caps, because a ceiling is the only guard between a leak and the machine", () => {
    expect(resolveDaemonHeapMb(512 * GB, {})).toBe(24576);
    expect(resolveDaemonHeapMb(1024 * GB, {})).toBe(24576);
  });

  it("keeps a floor so a small machine still gets a usable daemon", () => {
    expect(resolveDaemonHeapMb(4 * GB, {})).toBe(2048);
    expect(resolveDaemonHeapMb(8 * GB, {})).toBe(2048);
  });

  it("honours an explicit override, and ignores a nonsensical one", () => {
    expect(resolveDaemonHeapMb(128 * GB, { CODESIFT_DAEMON_HEAP_MB: "3000" } as NodeJS.ProcessEnv)).toBe(3000);
    // Too small to run on, and unparseable — both fall back to the scaled value
    // rather than producing a daemon that cannot start.
    expect(resolveDaemonHeapMb(128 * GB, { CODESIFT_DAEMON_HEAP_MB: "64" } as NodeJS.ProcessEnv)).toBe(16384);
    expect(resolveDaemonHeapMb(128 * GB, { CODESIFT_DAEMON_HEAP_MB: "abc" } as NodeJS.ProcessEnv)).toBe(16384);
  });

  it("sets a young-generation size, because the old generation is large BY DESIGN", async () => {
    // Left at V8's default until 2026-08-28. For a large heap that is ~16 MB, so scavenges fire
    // constantly and each one walks every old-generation memory chunk — and this daemon keeps 4 GB
    // of index cache resident on purpose. Sampled under load: 35% of main-thread time in
    // Heap::CollectGarbage, 33% inside OldGenerationMemoryChunkIterator::next. After the change,
    // 11% and 0%.
    const home = await mkdtemp(join(tmpdir(), "codesift-semi-"));
    const dataDir = join(home, ".codesift");
    try {
      const plist = buildLaunchAgentPlist(
        buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
      );
      expect(plist).toContain("--max-semi-space-size=64");
      const unit = buildSystemdUnit(buildServicePlan({ dataDir, home, os: "linux", ...PLAN_OPTS }));
      expect(unit).toContain("--max-semi-space-size=64");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("puts the flag BEFORE the script path in both unit formats", async () => {
    // node reads options only ahead of the script; placed after, it becomes an
    // argument to the CLI and is silently ignored — an unchanged limit under a
    // plist that reads as correct.
    const home = await mkdtemp(join(tmpdir(), "codesift-heap-"));
    const dataDir = join(home, ".codesift");
    try {
      const plist = buildLaunchAgentPlist(
        buildServicePlan({ dataDir, home, os: "darwin", ...PLAN_OPTS }),
      );
      const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
      const flag = args.findIndex((a) => a?.startsWith("--max-old-space-size="));
      const script = args.findIndex((a) => a?.endsWith("cli.js"));
      expect(flag).toBeGreaterThan(-1);
      expect(script).toBeGreaterThan(-1);
      expect(flag).toBeLessThan(script);

      const unit = buildSystemdUnit(buildServicePlan({ dataDir, home, os: "linux", ...PLAN_OPTS }));
      const exec = unit.split("\n").find((l) => l.startsWith("ExecStart=")) ?? "";
      expect(exec.indexOf("--max-old-space-size=")).toBeGreaterThan(-1);
      expect(exec.indexOf("--max-old-space-size=")).toBeLessThan(exec.indexOf("cli.js"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
