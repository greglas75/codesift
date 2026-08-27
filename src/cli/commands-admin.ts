import type { Flags } from "./args.js";
import { getFlag, getBoolFlag, getNumFlag, requireArg, requireFlag, output, die } from "./args.js";

// ---------------------------------------------------------------------------
// Analysis commands
// ---------------------------------------------------------------------------

async function handleComplexity(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { analyzeComplexity } = await import("../tools/complexity-tools.js");

  const result = await analyzeComplexity(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    top_n: getNumFlag(flags, "top-n"),
    min_complexity: getNumFlag(flags, "min-complexity"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}

async function handleDeadCode(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { findDeadCode } = await import("../tools/symbol-tools.js");

  const result = await findDeadCode(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}

async function handleHotspots(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { analyzeHotspots } = await import("../tools/hotspot-tools.js");

  const result = await analyzeHotspots(repo, {
    since_days: getNumFlag(flags, "since-days"),
    top_n: getNumFlag(flags, "top-n"),
    file_pattern: getFlag(flags, "file-pattern"),
  });
  output(result, flags);
}

async function handleCommunities(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { detectCommunities } = await import("../tools/community-tools.js");

  const result = await detectCommunities(
    repo,
    getFlag(flags, "focus"),
    getNumFlag(flags, "resolution"),
    getFlag(flags, "output-format") as "json" | "mermaid" | undefined,
  );
  output(result, flags);
}

async function handlePatterns(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const pattern = requireFlag(flags, "pattern");
  const { searchPatterns } = await import("../tools/pattern-tools.js");

  const result = await searchPatterns(repo, pattern, {
    file_pattern: getFlag(flags, "file-pattern"),
    include_tests: getBoolFlag(flags, "include-tests"),
    max_results: getNumFlag(flags, "max-results"),
  });
  output(result, flags);
}

async function handleSetup(args: string[], flags: Flags): Promise<void> {
  const platform = args[0];
  const { formatSetupLines, SUPPORTED_PLATFORMS } = await import("./setup.js");

  if (!platform) {
    die(`Missing platform. Usage: codesift setup <${SUPPORTED_PLATFORMS.join("|")}|all>`);
    return;
  }

  const hooks = getBoolFlag(flags, "no-hooks")
    ? false
    : (getBoolFlag(flags, "hooks") ?? true);
  const rules = getBoolFlag(flags, "no-rules")
    ? false
    : (getBoolFlag(flags, "rules") ?? true);
  const force = getBoolFlag(flags, "force") ?? false;
  // `--no-git-hooks` is a standalone boolean flag (parseArgs stores "no-git-hooks", not "git-hooks": false).
  const gitHooks = getBoolFlag(flags, "no-git-hooks")
    ? false
    : (getBoolFlag(flags, "git-hooks") ?? hooks);
  // --http points the client at the shared `codesift serve` daemon (one process
  // per machine) instead of spawning a stdio server per editor window.
  const http = getBoolFlag(flags, "http") ?? false;
  const port = getNumFlag(flags, "port");
  // A SHARED daemon needs a host and a token; without these `--http` could only
  // ever mean "the daemon on this machine", which defeats the point of having
  // one process serve several.
  const daemonHost = getFlag(flags, "host");
  const daemonToken = getFlag(flags, "token") ?? process.env["CODESIFT_HTTP_TOKEN"];
  // A bearer token on a plaintext link to another machine is refused unless the operator either
  // asks for https or states that the transport is already encrypted (tailnet/VPN/SSH tunnel).
  const rawScheme = getFlag(flags, "scheme");
  const daemonScheme: "http" | "https" | undefined =
    rawScheme === "https" ? "https" : rawScheme === "http" ? "http" : undefined;
  const insecureTransport = getBoolFlag(flags, "insecure-transport") ?? false;
  // --project writes the client config into THIS project instead of the user's home, and pins this
  // directory into the URL. It exists because a client whose MCP config is global cannot use the
  // shared daemon at all: one URL carries one directory, so one global entry cannot describe two
  // projects, and the client falls back to a stdio process per session.
  //
  // Without --project, `--http` writes the GLOBAL entry as a bare daemon URL (no ?cwd=), which is
  // the transport half; each project's own config then supplies the directory half by overriding
  // the same key. A global entry that pinned one directory would be actively wrong for every other
  // project on the machine.
  const projectScope = getBoolFlag(flags, "project") ?? false;
  const options = {
    hooks, rules, force, gitHooks, http,
    ...(projectScope ? { projectScope: true, cwd: process.cwd() } : http ? { cwd: null } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(daemonHost ? { host: daemonHost } : {}),
    ...(daemonToken ? { token: daemonToken } : {}),
    ...(daemonScheme ? { scheme: daemonScheme } : {}),
    ...(insecureTransport ? { insecureTransport } : {}),
  };

  /** Global post-commit backlog hook — wired here because `formatSetupLines` stays editor-setup only (see setup/setupAll for programmatic installs). */
  async function emitGlobalGitHooksIfRequested(): Promise<void> {
    if (options.gitHooks === false) return;
    // Match setup(): git hooks accompany editor hooks by default; allow `--git-hooks` without `--hooks`.
    const wantGitHooks = options.hooks || getBoolFlag(flags, "git-hooks") === true;
    if (!wantGitHooks) return;

    const { installGitHooks } = await import("./git-hooks-installer.js");
    const result = await installGitHooks({ force });
    if (result.reason) {
      process.stdout.write(`⚠️ git hooks: ${result.reason}\n`);
      return;
    }
    process.stdout.write(`✓ git post-commit hook → ${result.hooksPath}\n`);
    if (result.hooksPathSkippedReason) {
      process.stdout.write(`  (${result.hooksPathSkippedReason})\n`);
    }
  }

  if (platform === "all") {
    for (const p of SUPPORTED_PLATFORMS) {
      const lines = await formatSetupLines(p, options);
      for (const line of lines) process.stdout.write(line + "\n");
    }
    await emitGlobalGitHooksIfRequested();
    return;
  }

  const lines = await formatSetupLines(platform, options);
  for (const line of lines) process.stdout.write(line + "\n");
  await emitGlobalGitHooksIfRequested();
}

async function handleFindClones(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { findClones } = await import("../tools/clone-tools.js");

  const result = await findClones(repo, {
    file_pattern: getFlag(flags, "file-pattern"),
    min_similarity: getNumFlag(flags, "threshold"),
    min_lines: getNumFlag(flags, "min-lines"),
    include_tests: getBoolFlag(flags, "include-tests"),
  });
  output(result, flags);
}


/**
 * `codesift service install|uninstall|status` — supervise the shared daemon.
 *
 * `serve` alone dies with the terminal that started it and never comes back
 * after a crash or reboot, which is precisely the failure the shared-daemon
 * model cannot tolerate: every client is configured to talk to one process.
 */
async function handleService(args: string[], flags: Flags): Promise<void> {
  const { installService, uninstallService, serviceStatus, DEFAULT_SERVICE_PORT } =
    await import("./service.js");
  const { loadConfig } = await import("../config.js");
  const dataDir = loadConfig().dataDir;
  const sub = args[0] ?? "status";

  try {
    if (sub === "install") {
      const port = getNumFlag(flags, "port") ?? DEFAULT_SERVICE_PORT;
      const host = getFlag(flags, "host") ?? "127.0.0.1";
      // A routable bind needs a token; the server enforces the same rule.
      const token = getFlag(flags, "token") ?? process.env["CODESIFT_HTTP_TOKEN"];
      // Carry the caller's CODESIFT_* environment into the unit. A service gets
      // almost nothing from the shell, so an embedding provider set only in the
      // shell is silently lost and the daemon falls back to on-CPU ONNX.
      const inheritedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith("CODESIFT_") && k !== "CODESIFT_HTTP_TOKEN" && typeof v === "string") {
          inheritedEnv[k] = v;
        }
      }
      output(
        installService({
          dataDir, port, host,
          ...(token ? { token } : {}),
          ...(Object.keys(inheritedEnv).length > 0 ? { env: inheritedEnv } : {}),
          force: getBoolFlag(flags, "force") === true,
        }),
        flags,
      );
      return;
    }
    if (sub === "uninstall") {
      output(uninstallService({ dataDir }), flags);
      return;
    }
    if (sub === "status") {
      output(serviceStatus({ dataDir }), flags);
      return;
    }
  } catch (e) {
    die(`service: ${(e as Error).message}`);
    return;
  }
  die(`service: unknown subcommand "${sub}" (expected install, uninstall or status)`);
}

export {
  handleComplexity,
  handleDeadCode,
  handleHotspots,
  handleCommunities,
  handlePatterns,
  handleSetup,
  handleFindClones,
  handleService,
};
