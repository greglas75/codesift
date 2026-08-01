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

describe("HTTP daemon — learning the client's directory", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it("asks the client for its roots, and only after the client can receive it", async () => {
    // Every earlier attempt failed here, each for a different reason, and all
    // of them surfaced identically as `roots/list` timing out — which reads as
    // "this client has no roots support" rather than "we asked at the wrong
    // moment". Asking during initialize is too early (the client is still
    // inside connect() with no stream); asking on `notifications/initialized`
    // is too early for the same reason; and blocking the GET stream — or the
    // POST carrying the client's own answer — on the lookup deadlocks it
    // against itself.
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;

    let asked = false;
    const client = new Client(
      { name: "roots-test", version: "1" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => {
      asked = true;
      return { roots: [{ uri: pathToFileURL(process.cwd()).href, name: "ws" }] };
    });

    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    // The lookup fires on the first post-handshake REQUEST, not during connect.
    expect(asked).toBe(false);

    await client.listTools();
    expect(asked).toBe(true);

    await client.close();
  }, 60_000);

  it("serves a client that declares no roots instead of hanging on it", async () => {
    // A client without roots support must still work — it just cannot rely on
    // auto-resolution. The lookup fails, the request proceeds.
    const handle = await startHttpServer({ port: 0 });
    close = handle.close;

    const client = new Client({ name: "no-roots", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await client.close();
  }, 90_000);
});
