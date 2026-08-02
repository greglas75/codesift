#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import {
  registerTools,
  enableFrameworkToolBundle,
  frontLoadHiddenToolsForFrozenHost,
  shouldFrontLoadHiddenTools,
} from "./register-tools.js";
import { autoDiscoverConversations } from "./tools/conversation-tools.js";
import { autoIndexCurrentRepo } from "./tools/index-tools.js";
import { maybePrintFirstRunNotice } from "./storage/telemetry/config.js";
import { startTelemetryTimer } from "./storage/telemetry/uploader.js";
import { CODESIFT_INSTRUCTIONS } from "./instructions.js";
import { setupHooksForPlatform } from "./cli/setup.js";
import { detectPlatform, detectPlatformFromClientInfo, type HookPlatform } from "./cli/platform.js";
import { createRequire } from "node:module";
import { timingSafeEqual } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { statSync } from "node:fs";
import { isLoopbackHost } from "./utils/loopback.js";
import { runWithRequestContext } from "./server-helpers/request-context.js";

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

/**
 * Exit when the client (Claude/Codex) that spawned us goes away.
 *
 * A stdio MCP server has no reason to outlive its parent — the only client is
 * on the other end of the pipe. But background timers keep the event loop
 * alive (the chokidar index watcher, auto-index, conversation discovery), so
 * when the parent dies the process does NOT drain and exit on its own: it gets
 * reparented to launchd/init (ppid 1) and lingers forever, holding its
 * indexes + embeddings (often 1-4 GB) and, if the watcher is churning, burning
 * a core. Across ~10 concurrent Claude/Codex sessions that leaked 50+ orphans
 * eating tens of GB and multiple cores — "codesift is killing my machine".
 *
 * The fixes below all converge on the same action: as soon as the transport
 * closes OR stdin hits EOF OR we get a termination signal, exit hard. `exit`
 * fires the sidecar cleanup above; chokidar/fds are released by process teardown.
 * Idempotent so overlapping triggers (stdin close + transport close) don't double-log.
 */
let shuttingDown = false;
function shutdownOnParentGone(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[codesift] parent gone (${reason}) — exiting`);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => shutdownOnParentGone(sig));
}
// NOTE: stdin EOF handlers are attached ONLY in the stdio path (see runStdio),
// never globally — the HTTP daemon (`codesift serve`) is meant to outlive its
// launcher and must not exit just because its stdin was closed at spawn.

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



export interface HttpServerHandle {
  /** Actual listening port (resolved when port 0 was requested). */
  port: number;
  /** MCP endpoint URL. */
  url: string;
  /** Number of live MCP sessions (one McpServer each; all share process caches). */
  sessionCount: () => number;
  close: () => Promise<void>;
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

/**
 * Working directory declared in the connection URL: `/mcp?cwd=/abs/path`.
 *
 * Module scope now that serving is stateless: there is no session object to
 * hang it on, and every request carries it independently.
 *
 * Validated rather than trusted: an absolute path to a real directory or
 * nothing. Not a security boundary (the daemon is loopback-only and already
 * serves every indexed repo to any local caller) but it keeps a typo from
 * silently resolving every repo to garbage.
 */
function cwdFromUrl(rawUrl: string): string | undefined {
  const q = rawUrl.indexOf("?");
  if (q < 0) return undefined;
  let value: string | null;
  try {
    value = new URLSearchParams(rawUrl.slice(q + 1)).get("cwd");
  } catch {
    return undefined;
  }
  if (!value) return undefined;
  try {
    const resolved = pathResolve(value);
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time bearer comparison.
 *
 * `!==` on strings short-circuits at the first differing byte, so response time leaks a
 * prefix-match length. That is a weak channel over a real network, but this token is static,
 * reusable, and grants every tool on the daemon — the same reasoning that made us refuse to put
 * it on a plaintext link applies to how it is checked. Length is compared first because
 * timingSafeEqual throws on a length mismatch (and a length leak is not the interesting one).
 */
function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export async function startHttpServer(
  opts: { port?: number; host?: string; token?: string } = {},
): Promise<HttpServerHandle> {
  const http = await import("node:http");
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");

  const host = opts.host ?? "127.0.0.1"; // loopback unless a token is configured
  const token = opts.token ?? process.env["CODESIFT_HTTP_TOKEN"];

  // A non-loopback bind is refused UNLESS a bearer token is configured.
  //
  // The refusal exists because the daemon answers tool calls that read every
  // indexed repository — source, and indexed conversation history — with no
  // authentication at all. Exposing that on an interface is publishing it.
  //
  // A token is an authentication model, so the reason to refuse goes away with
  // it. This is what lets one host serve several machines (a shared box, a CI
  // runner) instead of every workstation running its own copy — which is the
  // whole point of stateless serving. Without it the daemon could never be
  // anything but per-machine.
  //
  // Still not a licence to bind 0.0.0.0 casually: the caller chooses the
  // interface, and a private one (tailnet, VPN) plus a token is a very
  // different exposure from a public IP plus a token.
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `codesift HTTP daemon refuses non-loopback bind "${host}" without a token — `
      + "it would serve every indexed repository unauthenticated. "
      + "Set CODESIFT_HTTP_TOKEN (or --token) to bind a routable interface.",
    );
  }

  /**
   * Stateless serving (MCP 2026-07-28, and the default for `legacy` clients).
   *
   * The previous implementation kept an `Mcp-Session-Id` → session map, which
   * made a daemon restart fatal to every connected client: each one held an id
   * the new process had never issued, so its next call came back
   * `no valid session` and stayed broken until someone reconnected it by hand.
   * That happened on every `service install --force`, i.e. every upgrade, and
   * it bit repeatedly while this was being built.
   *
   * With no protocol-level session there is nothing to invalidate. Verified
   * against a 2025-era client — the era Claude Code 2.1.220 still negotiates:
   * the server process was replaced mid-conversation and the same client kept
   * calling tools without re-initializing.
   *
   * The other half is that any request may land on any instance, which is what
   * makes more than one process — or a remote host — possible at all without a
   * shared session store.
   */
  const handler = createMcpHandler(() => createCodesiftServer(), { legacy: "stateless" });
  const nodeHandler = toNodeHandler(handler);

  let inFlight = 0;

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        if (url === "/health" || url.startsWith("/health?")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", sessions: inFlight, version: PKG_VERSION }));
          return;
        }
        if (token) {
          const auth = req.headers["authorization"];
          if (!bearerMatches(auth, token)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }));
            return;
          }
        }

        // The caller's directory, pinned per request. Statelessness makes this
        // the natural carrier: there is no session to have learned it once.
        const cwd = cwdFromUrl(url);
        inFlight++;
        try {
          await (cwd
            // Cast: Node types `method`/`url` as optional, the handler wants
            // them required. Both are always present on a served request.
            ? runWithRequestContext({ cwd }, () => nodeHandler(req as never, res))
            : nodeHandler(req as never, res));
        } finally {
          inFlight--;
        }
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
    // No sessions to count any more; report work in flight so /health still
    // says something true about load.
    sessionCount: () => inFlight,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
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

  // stdio only: stdin EOF/close is the canonical "parent died" signal. Attached
  // here (not globally) so the HTTP daemon path is unaffected.
  process.stdin.on("end", () => shutdownOnParentGone("stdin end"));
  process.stdin.on("close", () => shutdownOnParentGone("stdin close"));

  const transport = new StdioServerTransport();
  // Diagnostic transport hooks. Primary fix for "-32000: Connection closed" is
  // event-loop yielding inside heavy tools (perf-tools, hotspot-tools, project-tools);
  // these handlers leave a stderr trace if any residual transport drop occurs.
  transport.onclose = () => {
    console.error(`[codesift] transport closed at uptime=${Date.now() - startTs}ms`);
    // The client disconnected — do NOT keep running as an orphan. Background
    // timers (watcher/auto-index) would otherwise hold the event loop open and
    // the process would linger under launchd forever. See shutdownOnParentGone.
    shutdownOnParentGone("transport close");
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
    const clientName = server.server.getClientVersion()?.name ?? "";
    const clientPlatform = detectPlatformFromClientInfo(clientName);
    const platform = envPlatform !== "unknown" ? envPlatform : clientPlatform;

    // Front-load reveal-dependent tools for hosts that freeze their tool list
    // at session start. This runs in the `initialized` notification, i.e. before
    // the client's first tools/list, which is the only window where enabling a
    // tool still reaches that host. See FROZEN_LIST_FALLBACK_TOOL_NAMES.
    if (shouldFrontLoadHiddenTools(platform)) {
      const enabled = frontLoadHiddenToolsForFrozenHost();
      if (enabled.length > 0) {
        console.error(
          `[codesift] ${platform || "host"} does not refresh its tool list mid-session — ` +
            `made ${enabled.length} reveal-dependent tools visible up front: ${enabled.join(", ")}`,
        );
      }
    }

    if (hooksInstalledFor !== null || envPlatform !== "unknown") return;
    installHooks(clientPlatform === "unknown" ? "claude" : clientPlatform, clientName || "fallback");
  };

  await server.connect(transport);
  console.error("CodeSift MCP server started");

  // Telemetry: one-time consent notice (stderr) + background flush timer.
  // No-op when telemetry is off or no endpoint is configured (safe default).
  maybePrintFirstRunNotice();
  startTelemetryTimer();

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
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
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
