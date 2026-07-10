import type { SetupOptions, SetupResult } from "./types.js";
import { setupJsonPlatform } from "./mcp.js";

const CURSOR_CONFIG = { configDirName: ".cursor", configFileName: "mcp.json" };

export function setupCursor(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("cursor", CURSOR_CONFIG, options);
}
