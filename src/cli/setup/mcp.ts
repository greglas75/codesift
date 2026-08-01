import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
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
 * it cannot know where any given client works. The protocol's answer to that is
 * `roots/list` — but Claude Code replies `-32601 Method not found`, so for the
 * main client it does not exist. Measured, not assumed: switching it to a plain
 * daemon URL made every auto-resolved call fail with
 * `Repository "local/" not found`.
 *
 * The client cannot tell the daemon where it is; its CONFIG can. Pinning the
 * directory here is what makes an HTTP entry usable at all, which is also why
 * an HTTP entry is inherently PER-PROJECT — one shared URL cannot describe two
 * projects.
 */
export function daemonHttpUrl(port?: number, cwd?: string): string {
  const base = "http://127.0.0.1:" + (port ?? DEFAULT_DAEMON_PORT) + "/mcp";
  const dir = cwd ?? process.cwd();
  return base + "?cwd=" + encodeURIComponent(dir);
}

export function buildJsonServerEntry(options?: SetupOptions): Record<string, unknown> {
  if (options?.http) {
    return { type: "http", url: daemonHttpUrl(options.port, options.cwd) };
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
