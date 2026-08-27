import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { ensureDir, writeJsonFile } from "./fs.js";
import { hasCodesiftHook, loadHooksSection, type HookEntry } from "./hooks.js";
import { setupJsonPlatform } from "./mcp.js";

const GEMINI_CONFIG = { configDirName: ".gemini", configFileName: "settings.json" };

/**
 * Antigravity deliberately carries NO `workspaceVar` — it must stay on stdio.
 *
 * Probed against `antigravity-client v1.0.0` (2026-08-27), and every part of this
 * was measured, because each one on its own would have justified converting it:
 *
 *   - It expands NO variable syntax. `${workspaceFolder}`, `${workspaceRoot}`,
 *     `${cwd}`, `${env:PWD}`, `$PWD`, `${PWD}` and `${projectRoot}` all arrived
 *     at the server verbatim. A global HTTP entry would therefore send an
 *     unexpandable placeholder from every project.
 *   - It declares `roots` with `listChanged: true` and then answers `roots/list`
 *     with `[]`, even with a project open. Declaring the capability is not
 *     evidence of using it — and the daemon serves statelessly anyway, so it
 *     could not ask.
 *   - Its stdio child gets the PROJECT directory as its cwd, so repo
 *     auto-resolution already works. Cursor's, by contrast, gets `$HOME`.
 *
 * Net: converting Antigravity to the daemon would REPLACE a working directory
 * with none. That is a regression dressed as a consolidation, so it is written
 * down here rather than left to be rediscovered.
 */
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
