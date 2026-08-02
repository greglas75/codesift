
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { isLoopbackHost, assertPlainHost } from "../../utils/loopback.js";
export { isLoopbackHost } from "../../utils/loopback.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs.js";

export interface JsonPlatformConfig {
  configDirName: string;
  configFileName: string;
}

const DEFAULT_DAEMON_PORT = 7077;

export function resolveMcpServerEntry(): { command: string; args: string[] } {
  // NOTE: these two lookups used to `require("node:child_process")`. The package
  // is ESM, so the bare require threw ReferenceError, both try blocks fell
  // through, and setup ALWAYS wrote the `npx -y codesift-mcp` fallback — even
  // with codesift-mcp installed globally. Keep execSync a static import.
  try {
    const serverPath = execSync("which codesift-mcp", { encoding: "utf-8" }).trim();
    if (serverPath) {
      return { command: serverPath, args: [] };
    }
  } catch { /* not globally installed — fall back to npx */ }

  try {
    const npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
    if (npxPath) {
      return { command: npxPath, args: ["-y", "codesift-mcp"] };
    }
  } catch { /* fallback */ }

  return { command: "npx", args: ["-y", "codesift-mcp"] };
}

const MCP_SERVER_ENTRY = resolveMcpServerEntry();

/**
 * Daemon URL, with the caller's project directory pinned into it.
 *
 * The daemon is one process for every client and launchd starts it in `/`, so
 * it cannot know where any given client works. Measured, not assumed: switching
 * a client to a plain daemon URL made every auto-resolved call fail with
 * `Repository "local/" not found`.
 *
 * CORRECTION: this comment used to say Claude Code answers `roots/list` with
 * `-32601 Method not found`. Probed directly, it does not — Claude Code 2.1.220
 * declares the capability and returns its workspace directory. The -32601 in the
 * daemon log belonged to another client; the log does not say which, and
 * attributing it was a guess.
 *
 * Pinning the directory here is still worth doing: config is deterministic where
 * a reported root is not, it saves the round-trip, and it covers clients that do
 * lack roots.
 *
 * The client cannot tell the daemon where it is; its CONFIG can. Pinning the
 * directory here is what makes an HTTP entry usable at all, which is also why
 * an HTTP entry is inherently PER-PROJECT — one shared URL cannot describe two
 * projects.
 */

export function daemonHttpUrl(
  port?: number,
  cwd?: string,
  host?: string,
  scheme?: "http" | "https",
): string {
  // Host is a parameter, not a constant. It was hardcoded to 127.0.0.1, which
  // silently made `setup --http` a local-only feature: a SHARED daemon — the
  // entire reason stateless serving exists — could not be configured without
  // hand-editing every client's JSON. Adding a machine to a shared instance has
  // to be one command, or nobody will do it twice.
  const rawHost = host ?? "127.0.0.1";
  assertPlainHost(rawHost);
  // Bracket IPv6 literals. Plain concatenation produced `http://::1:7077/mcp`,
  // which is not a parseable authority — a tailnet IPv6 daemon could not be
  // configured at all.
  const authorityHost = rawHost.includes(":") && !rawHost.startsWith("[")
    ? `[${rawHost}]`
    : rawHost;
  const url = new URL(
    `${scheme ?? "http"}://${authorityHost}:${port ?? DEFAULT_DAEMON_PORT}/mcp`,
  );
  url.searchParams.set("cwd", cwd ?? process.cwd());
  return url.toString();
}

/**
 * Refuse to write a reusable bearer token onto a plaintext URL that leaves the machine.
 *
 * Requiring a token does not make a routable plaintext endpoint safe: the token is static and
 * replayable, and anything that captures it can call every tool — which exposes every indexed
 * repository and conversation on the daemon. Loopback is exempt (nothing leaves the host).
 *
 * `insecureTransport` is the deliberate escape for the deployment this feature was built for: a
 * tailnet or VPN where the transport is already encrypted below HTTP. It has to be stated, not
 * assumed, because the code cannot tell a tailnet address from a public one.
 */
export function assertTokenTransportIsSafe(options: SetupOptions): void {
  const host = options.host ?? "127.0.0.1";
  assertPlainHost(host);
  if (!options.token) return;
  if (isLoopbackHost(host)) return;
  if (options.scheme === "https") return;
  if (options.insecureTransport) return;
  throw new Error(
    `Refusing to write a bearer token for http://${host} — the token would travel in plaintext ` +
      `and anyone who captures it can read every indexed repo on that daemon. Use --scheme https, ` +
      `or pass --insecure-transport if the link is already encrypted (tailnet/VPN/SSH tunnel).`,
  );
}

export function buildJsonServerEntry(options?: SetupOptions): Record<string, unknown> {
  if (options?.http) {
    // A remote daemon requires a token (the server refuses a routable bind
    // without one), so it travels with the URL in the client entry.
    assertTokenTransportIsSafe(options);
    const entry: Record<string, unknown> = {
      type: "http",
      url: daemonHttpUrl(options.port, options.cwd, options.host, options.scheme),
    };
    if (options.token) entry["headers"] = { Authorization: `Bearer ${options.token}` };
    return entry;
  }
  return { ...MCP_SERVER_ENTRY };
}

function serverEntryKind(entry: unknown): "http" | "stdio" {
  if (
    entry &&
    typeof entry === "object" &&
    ((entry as Record<string, unknown>)["type"] === "http" || "url" in (entry as object))
  ) {
    return "http";
  }
  return "stdio";
}

/**
 * A stdio entry that must be REPLACED regardless of how it compares to the
 * desired one — i.e. the old direct-node invocation of a checked-out dev build
 * (`node /path/to/dist/server.js`), which silently pins a stale checkout.
 *
 * `npx -y codesift-mcp` is NOT legacy — it is exactly what resolveMcpServerEntry
 * produces when the binary is not globally installed (the documented npx install
 * path). Treating every `npx` command (and every `codesift-mcp` arg) as legacy
 * made serverEntriesEquivalent always return false for the desired entry, so
 * setup could never report `already_configured` and rewrote the config on every
 * single run. A genuinely different entry is still rewritten — the exact
 * command+args comparison below catches it.
 */
function isLegacyStdioEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const command = typeof record["command"] === "string" ? record["command"] : "";
  const args = Array.isArray(record["args"])
    ? record["args"].filter((arg): arg is string => typeof arg === "string")
    : [];
  return (
    command === "node" ||
    command.endsWith("/node") ||
    args.some((arg) => arg.includes("dist/server.js"))
  );
}

function serverEntriesEquivalent(existing: unknown, desired: Record<string, unknown>): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  if (serverEntryKind(existing) !== serverEntryKind(desired)) return false;
  if (serverEntryKind(desired) === "http") {
    return (existing as Record<string, unknown>)["url"] === desired["url"];
  }
  if (isLegacyStdioEntry(existing)) return false;

  const current = existing as Record<string, unknown>;
  return current["command"] === desired["command"] &&
    JSON.stringify(current["args"] ?? []) === JSON.stringify(desired["args"] ?? []);
}

export async function setupJsonPlatform(
  platform: string,
  config: JsonPlatformConfig,
  options?: SetupOptions,
): Promise<SetupResult> {
  const configDir = join(homedir(), config.configDirName);
  const configPath = join(configDir, config.configFileName);
  const entry = buildJsonServerEntry(options);

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const settings = await readJsonFile(configPath);
    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    const existing = mcpServers?.["codesift"];
    if (existing && serverEntriesEquivalent(existing, entry)) {
      return { platform, config_path: configPath, status: "already_configured" };
    }
    if (!settings["mcpServers"]) {
      settings["mcpServers"] = {};
    }
    (settings["mcpServers"] as Record<string, unknown>)["codesift"] = entry;
    await writeJsonFile(configPath, settings);
    return { platform, config_path: configPath, status: "updated" };
  }

  await writeJsonFile(configPath, { mcpServers: { codesift: entry } });
  return { platform, config_path: configPath, status: "created" };
}
