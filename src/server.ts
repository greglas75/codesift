import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./register-tools.js";
import { autoDiscoverConversations } from "./tools/conversation-tools.js";
import { CODESIFT_INSTRUCTIONS } from "./instructions.js";

// Re-export for test compatibility
export { buildResponseHint, resetSessionState } from "./server-helpers.js";

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

  // Auto-discover conversations for current project (background, non-blocking)
  autoDiscoverConversations(process.cwd()).catch((err: unknown) => {
    console.error("[codesift] conversation auto-discovery failed:", err);
  });
}

main().catch((err: unknown) => {
  console.error("Fatal error starting CodeSift MCP server:", err);
  process.exit(1);
});
