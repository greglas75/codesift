import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { startHttpServer, cwdFromUrl } from "../../src/server.js";
import {
  runWithRequestContext,
  currentCwd,
  hasRequestContext,
} from "../../src/server-helpers/request-context.js";

/**
 * A socket from the client's keep-alive pool that the previous server already
 * closed. Undici surfaces it as a transport failure with no HTTP response at all,
 * which is exactly what distinguishes it from a server that answered and rejected
 * us — the latter is a real regression and must never be retried away.
 */
function isDeadPooledSocket(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") return true;
    if (/other side closed|socket hang up/i.test(String((e as { message?: unknown }).message ?? ""))) {
      return true;
    }
  }
  return false;
}

/** Ask for the tool list, tolerating exactly one dead-pooled-socket failure. */
async function listToolsAcrossRestart(client: Client): ReturnType<Client["listTools"]> {
  try {
    return await client.listTools();
  } catch (err) {
    if (!isDeadPooledSocket(err)) throw err;
    return await client.listTools();
  }
}

/**
 * The shared HTTP daemon is ONE process for every client on the machine, started
 * by launchd in `/`. Repo auto-resolution reads a working directory, so without
 * a per-session one every daemon-served call answered
 * `Repository "local/" not found` — and auto-resolution is the documented
 * default, so that was most calls.
 */

describe("request context", () => {
  it("returns the request's cwd inside, the process's outside", () => {
    expect(hasRequestContext()).toBe(false);
    expect(currentCwd()).toBe(process.cwd());

    runWithRequestContext({ cwd: "/somewhere/else" }, () => {
      expect(hasRequestContext()).toBe(true);
      expect(currentCwd()).toBe("/somewhere/else");
    });

    expect(currentCwd()).toBe(process.cwd());
  });

  it("survives async boundaries within the request", async () => {
    await runWithRequestContext({ cwd: "/async/root" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentCwd()).toBe("/async/root");
    });
  });

  it("keeps concurrent requests apart", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithRequestContext({ cwd: "/a" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentCwd());
      }),
      runWithRequestContext({ cwd: "/b" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(currentCwd());
      }),
    ]);
    expect(seen.sort()).toEqual(["/a", "/b"]);
  });
});

describe("HTTP daemon — stateless serving", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it("does not ask the client for roots — every request carries its own directory", async () => {
    // Stateless serving has no session to cache a roots answer in, so a
    // round-trip per request would be pure cost. The directory travels in the
    // URL instead, which is deterministic and free.
    //
    // The earlier session-based implementation DID ask, and getting that
    // handshake delivered took four attempts, each failing as an
    // indistinguishable timeout. Statelessness removes the whole problem
    // rather than solving it.
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;

    let asked = false;
    const client = new Client(
      { name: "roots-capable", version: "1" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => {
      asked = true;
      return { roots: [{ uri: pathToFileURL(process.cwd()).href, name: "ws" }] };
    });

    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    await client.listTools();

    expect(asked).toBe(false);
    await client.close();
  }, 60_000);

  it("serves a client that declares no roots at all", async () => {
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;

    const client = new Client({ name: "no-roots", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await client.close();
  }, 90_000);

  it("keeps serving the same client after the server instance is replaced", async () => {
    // The reason the migration was worth doing. With a protocol-level session,
    // every `service install --force` — i.e. every upgrade — left each connected
    // client holding an id the new process had never issued, and its next call
    // came back `no valid session` until someone reconnected it by hand.
    const first = await startHttpServer({ port: 0 });
    const { port } = first;

    const client = new Client({ name: "survivor", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(first.url)));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    // Replace the server entirely, reusing the port the client still points at.
    await first.close();
    const second = await startHttpServer({ port });
    close = second.close;

    // Same client object, no re-initialize.
    //
    // One transport-level retry, and only that. Closing the first server leaves the
    // client's pooled keep-alive socket dangling, so the first request after the swap
    // can die in undici with UND_ERR_SOCKET ("other side closed") before it ever
    // reaches the new process — measured 2 failures in 10 runs on the test farm, where
    // the extra load widens the window. That is HTTP connection reuse, not the thing
    // this test is about, and a real client retries it too.
    //
    // The regression this guards against looks different: it REACHES the new server and
    // comes back "no valid session", which is an MCP-level error and is not retried
    // here — so the retry cannot hide the failure the test exists to catch.
    const after = await listToolsAcrossRestart(client);
    expect(after.tools.length).toBeGreaterThan(0);

    await client.close();
  }, 90_000);
});

describe("HTTP daemon — directory pinned in the connection URL", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it("takes precedence over roots, so the round-trip never happens", async () => {
    // The protocol's own mechanism is not enough in practice: Claude Code
    // answers `roots/list` with -32601 Method not found, so a daemon serving it
    // has no way to learn where the caller works and every auto-resolved call
    // fails. The client cannot tell us, but its CONFIG can.
    //
    // This client CAN answer roots — and must still never be asked, because the
    // URL is what the user configured for this project while roots are a guess
    // about the window.
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;

    let asked = false;
    const client = new Client({ name: "url-cwd", version: "1" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => {
      asked = true;
      return { roots: [] };
    });

    const url = new URL(`${handle.url}?cwd=${encodeURIComponent(process.cwd())}`);
    await client.connect(new StreamableHTTPClientTransport(url));
    await client.listTools();

    // A pinned directory makes the roots round-trip unnecessary.
    expect(asked).toBe(false);
    await client.close();
  }, 60_000);

  it("ignores a cwd that is not a real directory rather than resolving to garbage", async () => {
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;
    const client = new Client({ name: "bad-cwd", version: "1" }, { capabilities: {} });
    // Nonexistent path: the daemon must fall through, not adopt it.
    const url = new URL(`${handle.url}?cwd=${encodeURIComponent("/no/such/dir/anywhere")}`);
    await client.connect(new StreamableHTTPClientTransport(url));
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    await client.close();
  }, 90_000);
});

describe("a daemon that was never told where the client works", () => {
  it("says so, instead of sending the caller off to re-index", async () => {
    // Removing the session removed the `roots/list` fallback with it, so a
    // client connecting without `?cwd=` has no directory at all. Left alone
    // that resolved to `local/` and surfaced as
    // `Repository "local/" not found. Run index_folder first.` — which points
    // an agent at re-indexing when the actual fault is a missing URL parameter.
    //
    // Asking for roots on every request instead would be a server->client
    // round-trip per tool call; stateless serving has no session to have
    // learned it once. The URL is the carrier, so a missing one is a
    // configuration fault and reads like one.
    const { resolveToolRepoArgs } = await import("../../src/server-helpers/repo-resolution.js");

    const args: Record<string, unknown> = {};
    expect(() =>
      runWithRequestContext({ cwd: "/" }, () => resolveToolRepoArgs("search_text", args)),
    ).toThrow(/does not know your working directory/);
  });

  it("stays silent outside a request — the CLI and tests are unaffected", async () => {
    const { resolveToolRepoArgs } = await import("../../src/server-helpers/repo-resolution.js");
    const args: Record<string, unknown> = {};
    // No request context: the process cwd is a real directory, so this resolves
    // normally rather than throwing.
    expect(() => resolveToolRepoArgs("search_text", args)).not.toThrow();
    expect(typeof args["repo"]).toBe("string");
  });
});

/**
 * A GLOBAL client entry can serve every project only if the client expands a
 * workspace variable into the URL. Cursor does — measured with an MCP probe on
 * 2026-08-27 — but the two shapes it produces both used to degrade into "no cwd"
 * without a word, which is the whole reason a globally-configured client could
 * not use the daemon.
 */
describe("cwdFromUrl — what a VS Code-derived client actually sends", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("accepts a plain absolute directory", () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-cwd-"));
    expect(cwdFromUrl(`/mcp?cwd=${encodeURIComponent(dir)}`)).toBe(dir);
  });

  it("expands a leading ~, which is what Cursor's ${workspaceFolder} expands to", () => {
    // Cursor returns `~/DEV/thing`, NOT an absolute path. `pathResolve` would
    // expand `~` against the daemon's own cwd (`/` under launchd) and produce
    // `/~/DEV/thing`, so the directory silently vanished.
    dir = mkdtempSync(join(homedir(), ".codesift-cwd-test-"));
    const tilde = `~/${relative(homedir(), dir)}`;
    expect(cwdFromUrl(`/mcp?cwd=${encodeURIComponent(tilde)}`)).toBe(dir);
  });

  it("refuses an unexpanded ${workspaceFolder} rather than treating it as a path", () => {
    // A Cursor window with no folder open leaves the placeholder verbatim.
    expect(cwdFromUrl("/mcp?cwd=" + encodeURIComponent("${workspaceFolder}"))).toBeUndefined();
    expect(cwdFromUrl("/mcp?cwd=" + encodeURIComponent("~/x/${workspaceFolder}"))).toBeUndefined();
  });

  it("refuses a relative path — resolving it against the daemon's / is meaningless", () => {
    expect(cwdFromUrl("/mcp?cwd=" + encodeURIComponent("DEV/codesift-mcp"))).toBeUndefined();
    expect(cwdFromUrl("/mcp?cwd=" + encodeURIComponent("./here"))).toBeUndefined();
  });

  it("refuses a file, a missing path, and a missing parameter", () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-cwd-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(cwdFromUrl(`/mcp?cwd=${encodeURIComponent(file)}`)).toBeUndefined();
    expect(cwdFromUrl(`/mcp?cwd=${encodeURIComponent(join(dir, "nope"))}`)).toBeUndefined();
    expect(cwdFromUrl("/mcp")).toBeUndefined();
    expect(cwdFromUrl("/mcp?cwd=")).toBeUndefined();
  });
});
