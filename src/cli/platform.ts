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
  const normalized = clientName.trim().toLowerCase();
  if (normalized === "claude-code" || normalized.includes("claude")) return "claude";
  if (normalized === "codex-mcp-client" || normalized.includes("codex")) return "codex";
  if (normalized === "gemini-cli-mcp-client" || normalized.includes("gemini")) return "gemini";
  if (normalized === "cline") return "cline";
  if (normalized === "continue-client" || normalized.includes("continue")) return "continue";
  return "unknown";
}
