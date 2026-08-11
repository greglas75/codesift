import type { SetupOptions, SetupResult } from "./types.js";
import { setupJsonPlatform } from "./mcp.js";

/**
 * Kimi Code (`@moonshot-ai/kimi-code`).
 *
 * The shape was read out of the CLI's own source rather than guessed: its
 * Codex-migration guidance states that Kimi stores servers as
 * `{"mcpServers": {...}}` in `~/.kimi-code/mcp.json`, and treats Codex's
 * `[mcp_servers.<name>]` TOML tables as an IMPORT format only.
 *
 * That distinction matters. `~/.kimi-code/config.toml` is the file `kimi doctor`
 * validates, so writing an MCP section there produces a config that passes
 * validation and is never read — the silent half-failure this whole setup path
 * exists to avoid.
 */
const KIMI_CONFIG = { configDirName: ".kimi-code", configFileName: "mcp.json" };

export function setupKimi(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("kimi", KIMI_CONFIG, options);
}
