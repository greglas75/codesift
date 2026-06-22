import { describe, it, expect, afterEach } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server.js";

function initBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
}
function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(initBody()),
  });
}

describe("HTTP daemon security (Task 10)", () => {
  let h: HttpServerHandle | null = null;
  afterEach(async () => {
    if (h) await h.close();
    h = null;
  });

  it("binds loopback only (url is 127.0.0.1) and refuses a non-loopback bind", async () => {
    h = await startHttpServer({ port: 0 });
    expect(h.url).toContain("127.0.0.1");
    await expect(startHttpServer({ port: 0, host: "0.0.0.0" })).rejects.toThrow(/non-loopback/i);
  });

  it("with CODESIFT_HTTP_TOKEN set, requests without the bearer token get 401", async () => {
    h = await startHttpServer({ port: 0, token: "s3cret" });
    const res = await post(h.url); // no Authorization header
    expect(res.status).toBe(401);
  });

  it("with the matching bearer token, the request is accepted", async () => {
    h = await startHttpServer({ port: 0, token: "s3cret" });
    const res = await post(h.url, { authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
  });

  it("/health is reachable without a token (liveness probe)", async () => {
    h = await startHttpServer({ port: 0, token: "s3cret" });
    const res = await fetch(h.url.replace("/mcp", "/health"));
    expect(res.status).toBe(200);
  });
});
