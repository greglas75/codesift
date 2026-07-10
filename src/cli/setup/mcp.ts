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
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const serverPath = execSync("which codesift-mcp", { encoding: "utf-8" }).trim();
    if (serverPath) {
      return { command: serverPath, args: [] };
    }
  } catch { /* not globally installed — fall back to npx */ }

  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
    if (npxPath) {
      return { command: npxPath, args: ["-y", "codesift-mcp"] };
    }
  } catch { /* fallback */ }

  return { command: "npx", args: ["-y", "codesift-mcp"] };
}

const MCP_SERVER_ENTRY = resolveMcpServerEntry();

export function daemonHttpUrl(port?: number): string {
  return "http://127.0.0.1:" + (port ?? DEFAULT_DAEMON_PORT) + "/mcp";
}

export function buildJsonServerEntry(options?: SetupOptions): Record<string, unknown> {
  if (options?.http) {
    return { type: "http", url: daemonHttpUrl(options.port) };
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

function isLegacyStdioEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const command = typeof record["command"] === "string" ? record["command"] : "";
  const args = Array.isArray(record["args"])
    ? record["args"].filter((arg): arg is string => typeof arg === "string")
    : [];
  return (
    /\bnpx$|\/npx$/.test(command) ||
    command === "npx" ||
    command.endsWith("/node") ||
    args.some((arg) => arg === "codesift-mcp" || arg.includes("dist/server.js"))
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
