#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./register-tools.js";
import { autoDiscoverConversations } from "./tools/conversation-tools.js";
import { autoIndexCurrentRepo } from "./tools/index-tools.js";
import { CODESIFT_INSTRUCTIONS } from "./instructions.js";
import { setupHooksForPlatform } from "./cli/setup.js";
import { detectPlatform, detectPlatformFromClientInfo } from "./cli/platform.js";

// Re-export for test compatibility
export { buildResponseHint, resetSessionState } from "./server-helpers.js";
export { resetSession } from "./storage/session-state.js";
import { cleanupSidecar, cleanupOrphanSidecars } from "./storage/session-state.js";

// Clean up orphan sidecar files from previous sessions
cleanupOrphanSidecars();

// Register sidecar cleanup on process exit
process.on("exit", () => {
  cleanupSidecar();
});

loadConfig();

const server = new McpServer(
  { name: "codesift-mcp", version: "0.1.0" },
  { instructions: CODESIFT_INSTRUCTIONS }
);

registerTools(server, { deferNonCore: true });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CodeSift MCP server started");

  // Auto-index current repo on first use (background, non-blocking)
  autoIndexCurrentRepo(process.cwd()).catch((err: unknown) => {
    console.error("[codesift] auto-index failed:", err);
  });

  // Auto-discover conversations for current project (background, non-blocking)
  autoDiscoverConversations(process.cwd()).catch((err: unknown) => {
    console.error("[codesift] conversation auto-discovery failed:", err);
  });

  // Auto-install hooks for the detected platform (idempotent)
  const envPlatform = detectPlatform();
  if (envPlatform !== "unknown") {
    setupHooksForPlatform(envPlatform).catch((err: unknown) => {
      console.error(`[codesift] hook auto-install failed (${envPlatform}):`, err);
    });
  } else {
    // Env detection failed — try clientInfo after MCP initialize.
    // The transport emits an internal event, but we can also just try
    // all safe platforms (Claude is the most common, always install).
    setupHooksForPlatform("claude").catch((err: unknown) => {
      console.error("[codesift] hook auto-install failed (claude fallback):", err);
    });
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error starting CodeSift MCP server:", err);
  process.exit(1);
});
