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
import { createRequire } from "node:module";

// Re-export for test compatibility
export { buildResponseHint, resetSessionState } from "./server-helpers.js";
export { resetSession } from "./storage/session-state.js";
import { cleanupSidecar, cleanupOrphanSidecars } from "./storage/session-state.js";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../package.json") as { version: string }).version;

// Clean up orphan sidecar files from previous sessions
cleanupOrphanSidecars();

// Register sidecar cleanup on process exit
process.on("exit", () => {
  cleanupSidecar();
});

/**
 * Last-line-of-defense crash guards. Tree-sitter parsing or symbol extraction
 * can throw on pathological inputs; without these handlers a single bad file
 * during index_folder kills the entire MCP server, which clients see as
 * "Connection closed". We log the error and let the originating tool handler
 * surface it normally, instead of taking down the whole process.
 *
 * These guards do NOT protect against native crashes inside web-tree-sitter
 * WASM (segfaults bypass the JS error machinery). Those remain a known
 * residual risk; mitigations are the per-file parse timeout in
 * parser-manager.ts and the max_files cap in index-tools.ts, which together
 * keep us out of the regions where WASM crashes have been observed.
 */
process.on("uncaughtException", (err: Error) => {
  console.error(
    `[codesift] uncaughtException (suppressed to keep MCP alive): ${err.message}\n${err.stack ?? ""}`,
  );
});

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.error(
    `[codesift] unhandledRejection (suppressed to keep MCP alive): ${message}${stack ? "\n" + stack : ""}`,
  );
});

loadConfig();

/** Build a fully-configured codesift McpServer (tools registered, not connected). */
export function createCodesiftServer(): McpServer {
  const s = new McpServer(
    { name: "codesift-mcp", version: PKG_VERSION },
    { instructions: CODESIFT_INSTRUCTIONS }
  );
  registerTools(s, { deferNonCore: true });
  return s;
}

const server = createCodesiftServer();

/** Bind addresses considered loopback-safe for the local daemon. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpServerHandle {
  /** Actual listening port (resolved when port 0 was requested). */
  port: number;
  /** MCP endpoint URL. */
  url: string;
  /** Number of live MCP sessions (one McpServer each; all share process caches). */
  sessionCount: () => number;
  close: () => Promise<void>;
}

/** Read and JSON-parse a request body (POST). Resolves undefined on malformed input. */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * Start the shared HTTP MCP daemon on loopback. Each MCP session gets its own
 * McpServer instance, but ALL sessions run in this one process and therefore
 * share the process-global embedding/index caches — that is the whole point:
 * embeddings load once for every editor window instead of once per window.
 *
 * Stateful Streamable-HTTP: `initialize` (no session header) mints a session id
 * returned in `mcp-session-id`; subsequent requests carry that header. Binds
 * 127.0.0.1 only; optional bearer token gates MCP requests (Task 10 hardens).
 */
export async function startHttpServer(
  opts: { port?: number; host?: string; token?: string } = {},
): Promise<HttpServerHandle> {
  const http = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const host = opts.host ?? "127.0.0.1"; // loopback only — never expose to the network
  // Hard refuse a non-loopback bind: the daemon serves trusted local editor
  // windows only and has no network auth model beyond the optional token.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `codesift HTTP daemon refuses non-loopback bind "${host}" — it is local-only by design.`,
    );
  }
  const token = opts.token ?? process.env["CODESIFT_HTTP_TOKEN"];

  type Session = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: McpServer;
  };
  const sessions = new Map<string, Session>();

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (url === "/health" || url.startsWith("/health?")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", sessions: sessions.size, version: PKG_VERSION }));
          return;
        }
        if (token) {
          const auth = req.headers["authorization"];
          if (auth !== `Bearer ${token}`) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }));
            return;
          }
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        const isInit =
          typeof body === "object" &&
          body !== null &&
          (body as { method?: string }).method === "initialize";

        let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          if (!isInit) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Bad Request: no valid session (initialize first)" },
              }),
            );
            return;
          }
          const mcp = createCodesiftServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, { transport, server: mcp });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          // Cast: the SDK declares Transport.onclose non-optional but
          // StreamableHTTPServerTransport types it optional — incompatible only
          // under exactOptionalPropertyTypes, harmless at runtime.
          await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
          session = { transport, server: mcp };
        }
        await session.transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
            }),
          );
        }
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, host, resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);

  return {
    port,
    url: `http://${host}:${port}/mcp`,
    sessionCount: () => sessions.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions.values()) void s.transport.close();
        sessions.clear();
        httpServer.close(() => resolve());
      }),
  };
}

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
  const startTs = Date.now();

  // Shared HTTP daemon mode: one process serves all editor windows, embeddings
  // load once. `codesift serve` (Task 7) sets CODESIFT_TRANSPORT=http.
  if (process.env["CODESIFT_TRANSPORT"] === "http") {
    const port = Number(process.env["CODESIFT_HTTP_PORT"]) || 7077;
    const handle = await startHttpServer({ port });
    console.error(`CodeSift MCP HTTP server on ${handle.url}`);
    autoEnableFrameworkToolsFromPackageJson(process.cwd()).catch(() => {});
    autoIndexCurrentRepo(process.cwd()).catch((err: unknown) => {
      console.error("[codesift] auto-index failed:", err);
    });
    autoDiscoverConversations(process.cwd()).catch((err: unknown) => {
      console.error("[codesift] conversation auto-discovery failed:", err);
    });
    return;
  }

  const transport = new StdioServerTransport();
  // Diagnostic transport hooks. Primary fix for "-32000: Connection closed" is
  // event-loop yielding inside heavy tools (perf-tools, hotspot-tools, project-tools);
  // these handlers leave a stderr trace if any residual transport drop occurs.
  transport.onclose = () => {
    console.error(`[codesift] transport closed at uptime=${Date.now() - startTs}ms`);
  };
  transport.onerror = (err: Error) => {
    console.error(`[codesift] transport error at uptime=${Date.now() - startTs}ms:`, err.message);
  };
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

// Auto-run only when executed as the entrypoint (`node dist/server.js`), not when
// imported by tests/tooling — importing must not boot a transport.
const isEntrypoint = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const { pathToFileURL } = require("node:url") as typeof import("node:url");
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("Fatal error starting CodeSift MCP server:", err);
    process.exit(1);
  });
}
