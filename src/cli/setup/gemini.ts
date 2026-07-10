import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { ensureDir, writeJsonFile } from "./fs.js";
import { hasCodesiftHook, loadHooksSection, type HookEntry } from "./hooks.js";
import { setupJsonPlatform } from "./mcp.js";

const GEMINI_CONFIG = { configDirName: ".gemini", configFileName: "settings.json" };
const ANTIGRAVITY_CONFIG = {
  configDirName: ".gemini/antigravity",
  configFileName: "mcp_config.json",
};

const GEMINI_HOOKS: Record<string, HookEntry> = {
  BeforeTool: {
    matcher: "read_file",
    hooks: [{ type: "command", command: "codesift precheck-read --stdin" }],
  },
  AfterTool: {
    matcher: "write_file|replace",
    hooks: [{ type: "command", command: "codesift postindex-file --stdin" }],
  },
  PreCompress: {
    matcher: "",
    hooks: [{ type: "command", command: "codesift precompact-snapshot --stdin" }],
  },
};

export function setupGemini(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("gemini", GEMINI_CONFIG, options);
}

export function setupAntigravity(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("antigravity", ANTIGRAVITY_CONFIG, options);
}

export async function setupGeminiHooks(): Promise<void> {
  const configDir = join(homedir(), ".gemini");
  const settingsPath = join(configDir, "settings.json");
  await ensureDir(configDir);
  const { root, hooks } = await loadHooksSection(settingsPath);

  for (const [eventName, hookEntry] of Object.entries(GEMINI_HOOKS)) {
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = [];
    }
    if (!hasCodesiftHook(hooks[eventName])) {
      hooks[eventName].push(hookEntry);
    }
  }

  await writeJsonFile(settingsPath, root);
}
