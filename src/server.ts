#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";
import { statSync } from "node:fs";
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
    /** Client's working directory — from the URL, else its MCP roots. */
    cwd?: string;
    /** Roots asked for already — success or not, we only ask once. */
    rootsResolved?: boolean;
    /** In-flight one-shot roots lookup; later requests await it. */
    rootsPromise?: Promise<void>;
  };


  /**
   * Working directory declared in the connection URL: `/mcp?cwd=/abs/path`.
   *
   * This exists because the protocol's own answer — `roots/list` — is not
   * universally implemented. Claude Code answers it with
   * `-32601 Method not found`, so a daemon serving it has no way to learn where
   * the caller works, and every auto-resolved call fails. The client cannot
   * tell us, but its CONFIG can: a project-scoped MCP entry pins the directory
   * into the URL, and the daemon reads it off every request.
   *
   * Takes precedence over roots when both are present — the URL is what the
   * user configured for this project, roots are a guess about the window.
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
   * Learn a session's working directory from the client's MCP roots.
   *
   * The daemon is one process for every client on the machine and launchd
   * starts it in `/`, so `process.cwd()` names no client's project. Without
   * this, every auto-resolved tool call answered `Repository "local/" not
   * found` — auto-resolution is the documented default, so that is most calls.
   * `roots/list` is the protocol's own answer to "where is the caller working";
   * we ask once per session and cache.
   *
   * Best-effort on purpose: a client that declares no roots capability, errors,
   * or reports none leaves `cwd` unset and the request falls back to
   * `process.cwd()` — no worse than before, and never a thrown request.
   */
  async function ensureSessionCwd(session: Session): Promise<void> {
    if (session.rootsResolved) return;
    session.rootsResolved = true;
    try {
      // Bounded, and much shorter than the SDK's 60s default. A client that
      // declares no roots support never answers, and the daemon must not stall
      // that client's FIRST tool call for a minute waiting to find out — the
      // answer is cached for the session, so the cost is paid once either way.
      const result = await session.server.server.listRoots(undefined, {
        timeout: ROOTS_LOOKUP_TIMEOUT_MS,
      });
      for (const root of result.roots ?? []) {
        const uri = typeof root.uri === "string" ? root.uri : "";
        if (!uri.startsWith("file://")) continue;
        session.cwd = fileURLToPath(uri);
        break;
      }
      if (session.cwd) {
        console.error(`[codesift] session cwd from client roots: ${session.cwd}`);
      } else {
        console.error("[codesift] client reported no usable file:// root — repo auto-resolution will not work for it");
      }
    } catch (err) {
      console.error(
        `[codesift] client does not support roots/list (${(err as Error).message}) — `
        + "repo auto-resolution will not work for it; pass repo= explicitly",
      );
    }
  }
  const sessions = new Map<string, Session>();

  /** How long to wait for a client to answer `roots/list` before giving up. */
  const ROOTS_LOOKUP_TIMEOUT_MS = 2000;

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
          // ONE object, referenced by both the map and the local variable.
          // Building a second literal inside onsessioninitialized meant every
          // mutation made while serving a request (the learned cwd) landed on an
          // object the next request would never see.
          const created: Session = { transport: undefined as never, server: mcp };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, created);
            },
          });
          created.transport = transport;
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          // Cast: the SDK declares Transport.onclose non-optional but
          // StreamableHTTPServerTransport types it optional — incompatible only
          // under exactOptionalPropertyTypes, harmless at runtime.
          await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
          session = created;
        }
        if (isInit) {
          // Just serve the handshake. Asking for roots here is too early: the
          // client is still inside connect() and has no stream to receive a
          // server->client request on, so `roots/list` times out and looks like
          // a client that does not support roots at all.
          await session.transport.handleRequest(req, res, body);
          return;
        }
        // Fire the roots lookup on the first post-handshake REQUEST (something
        // with an `id`), never on a notification.
        //
        // `notifications/initialized` is also a POST, but it arrives while the
        // client is still inside connect() with no stream to receive a
        // server->client request on — asking there times out and reads as "this
        // client has no roots support". By the first real request the client is
        // listening, so the lookup can actually be delivered.
        // A JSON-RPC REQUEST has both `method` and `id`. A RESPONSE has `id`
        // and no `method` — that distinction is load-bearing below.
        const msg = (typeof body === "object" && body !== null ? body : {}) as {
          method?: unknown; id?: unknown;
        };
        const isRequest = typeof msg.method === "string" && msg.id !== undefined;
        // A URL-pinned directory makes the roots round-trip unnecessary — and
        // for clients that answer `roots/list` with "method not found", it is
        // the only thing that works at all.
        const urlCwd = cwdFromUrl(url);
        if (urlCwd) {
          session.cwd = urlCwd;
          session.rootsResolved = true;
        } else if (req.method === "POST" && isRequest && !session.rootsResolved) {
          const s = session;
          s.rootsPromise = ensureSessionCwd(s);
        }
        // Wait for the one-shot roots lookup on POSTs only.
        //
        // The client receives server->client requests on the SSE stream it
        // opens with GET. Blocking that GET until roots resolve deadlocks the
        // pair — the stream waits for roots, roots wait for the stream — and
        // presents as `roots/list` timing out, which reads like a client that
        // does not support roots at all. DELETE (session teardown) must not
        // block either.
        // Wait for roots only on REQUESTS. The client's answer to `roots/list`
        // arrives as its own POST carrying a JSON-RPC response, and making that
        // POST wait for the lookup would make the lookup wait for itself — a
        // deadlock that surfaces as `roots/list` timing out, indistinguishable
        // from a client that has no roots support. GET (the SSE stream the
        // answer travels on) and DELETE must not block for the same reason.
        if (req.method === "POST" && isRequest && session.rootsPromise) {
          await session.rootsPromise.catch(() => undefined);
        }
        const cwd = session.cwd;
        await (cwd
          ? runWithRequestContext({ cwd }, () => session.transport.handleRequest(req, res, body))
          : session.transport.handleRequest(req, res, body));
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
