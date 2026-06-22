import { describe, it, expect, afterEach } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server.js";

/** Read an MCP response that may be JSON or an SSE `data:` frame. */
async function readMcp(res: Response): Promise<{ result?: { [k: string]: unknown }; error?: unknown }> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // SSE: take the last `data:` line
  const dataLine = trimmed.split("\n").reverse().find((l) => l.startsWith("data:"));
  return dataLine ? JSON.parse(dataLine.slice(5).trim()) : {};
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("HTTP transport (Task 6 spike)", () => {
  let h: HttpServerHandle | null = null;
  afterEach(async () => {
    if (h) await h.close();
    h = null;
  });

  it("boots on loopback and serves initialize + tools/list over HTTP", async () => {
    h = await startHttpServer({ port: 0 });
    expect(h.url).toContain("127.0.0.1");

    const initRes = await post(h.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(initRes.status).toBe(200);
    const sid = initRes.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    const initJson = await readMcp(initRes);
    expect((initJson.result?.["serverInfo"] as { name?: string })?.name).toBe("codesift-mcp");

    // Complete the MCP handshake before issuing further requests.
    await post(h.url, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid! });

    const listRes = await post(h.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sid! });
    const listJson = await readMcp(listRes);
    const tools = (listJson.result?.["tools"] as unknown[]) ?? [];
    expect(tools.length).toBeGreaterThanOrEqual(50);
  });

  it("answers GET /health with ok", async () => {
    h = await startHttpServer({ port: 0 });
    const res = await fetch(h.url.replace("/mcp", "/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });
});
