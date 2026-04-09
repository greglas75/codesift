// ---------------------------------------------------------------------------
// Platform detection — identify which AI coding tool is calling the MCP server
// ---------------------------------------------------------------------------

export type HookPlatform = "claude" | "codex" | "gemini" | "cline" | "continue" | "unknown";

/**
 * Detect platform from environment variables (available immediately at startup).
 * Falls back to "unknown" — use detectPlatformFromClientInfo() after MCP initialize.
 */
export function detectPlatform(): HookPlatform {
  if (process.env["CLAUDECODE"] === "1") return "claude";
  if (process.env["CODEX_THREAD_ID"]) return "codex";
  // Gemini and Cline don't set reliable env vars for MCP server processes
  return "unknown";
}

/**
 * Detect platform from MCP initialize clientInfo.name.
 * More reliable than env vars but only available after connection.
 */
export function detectPlatformFromClientInfo(clientName: string): HookPlatform {
  switch (clientName) {
    case "claude-code":
      return "claude";
    case "codex-mcp-client":
      return "codex";
    case "gemini-cli-mcp-client":
      return "gemini";
    case "Cline":
      return "cline";
    case "continue-client":
      return "continue";
    default:
      return "unknown";
  }
}
