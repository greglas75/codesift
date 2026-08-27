import type { SetupOptions, SetupResult } from "./types.js";
import { setupJsonPlatform } from "./mcp.js";

// Cursor keeps MCP config in ONE global file, so without a workspace variable it
// cannot use the shared daemon at all. Probed against Cursor 1.0 (2026-08-27): it
// expands `${workspaceFolder}`, and answers `roots/list` too — but the daemon is
// stateless, so roots is not available to it; the variable is.
const CURSOR_CONFIG = {
  configDirName: ".cursor",
  configFileName: "mcp.json",
  workspaceVar: "${workspaceFolder}",
};

export function setupCursor(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("cursor", CURSOR_CONFIG, options);
}
