import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

import { startHttpServer } from "../../src/server.js";
import {
  runWithRequestContext,
  currentCwd,
  hasRequestContext,
} from "../../src/server-helpers/request-context.js";

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
    const after = await client.listTools();
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
