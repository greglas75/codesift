#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools, enableFrameworkToolBundle } from "./register-tools.js";
import { autoDiscoverConversations } from "./tools/conversation-tools.js";
import { autoIndexCurrentRepo } from "./tools/index-tools.js";
import { CODESIFT_INSTRUCTIONS } from "./instructions.js";
import { setupHooksForPlatform } from "./cli/setup.js";
import { detectPlatform, detectPlatformFromClientInfo, type HookPlatform } from "./cli/platform.js";

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

/**
 * Quick framework detection from package.json — runs before first indexing.
 * Lets framework-specific tools (nest_*, etc.) appear in ListTools immediately
 * for projects detectable from dependencies, without waiting for a full index.
 */
async function autoEnableFrameworkToolsFromPackageJson(cwd: string): Promise<void> {
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const pkgPath = joinPath(cwd, "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ("@nestjs/core" in deps || "@nestjs/common" in deps) {
      const enabled = enableFrameworkToolBundle("nestjs");
      if (enabled.length > 0) {
        console.error(`[codesift] detected NestJS in ${cwd} — auto-enabled ${enabled.length} tools: ${enabled.join(", ")}`);
      }
    }
  } catch {
    // Non-fatal — this is a startup optimization
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const envPlatform = detectPlatform();
  let hooksInstalledFor: HookPlatform | null = null;
  const installHooks = (platform: HookPlatform, reason: string): void => {
    if (platform === "unknown" || hooksInstalledFor !== null) return;
    hooksInstalledFor = platform;
    setupHooksForPlatform(platform).catch((err: unknown) => {
      console.error(`[codesift] hook auto-install failed (${reason}:${platform}):`, err);
    });
  };

  server.server.oninitialized = () => {
    if (hooksInstalledFor !== null || envPlatform !== "unknown") return;
    const clientName = server.server.getClientVersion()?.name ?? "";
    const clientPlatform = detectPlatformFromClientInfo(clientName);
    installHooks(clientPlatform === "unknown" ? "claude" : clientPlatform, clientName || "fallback");
  };

  await server.connect(transport);
  console.error("CodeSift MCP server started");

  // Synchronous framework detection from package.json (runs before transport messages flow)
  autoEnableFrameworkToolsFromPackageJson(process.cwd()).catch(() => {});

  // Auto-index current repo on first use (background, non-blocking)
  autoIndexCurrentRepo(process.cwd()).catch((err: unknown) => {
    console.error("[codesift] auto-index failed:", err);
  });

  // Auto-discover conversations for current project (background, non-blocking)
  autoDiscoverConversations(process.cwd()).catch((err: unknown) => {
    console.error("[codesift] conversation auto-discovery failed:", err);
  });

  // Auto-install hooks for the detected platform (idempotent)
  if (envPlatform !== "unknown") {
    installHooks(envPlatform, "env");
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error starting CodeSift MCP server:", err);
  process.exit(1);
});
