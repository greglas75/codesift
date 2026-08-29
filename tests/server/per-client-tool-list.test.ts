import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpServer, clientFromUrl } from "../../src/server.js";

/**
 * One daemon answers every client on the machine, and they need OPPOSITE tool lists.
 *
 * Codex freezes its list at session start, so a tool not offered up front is unreachable for the
 * whole session. Claude Code refreshes on demand and measurably STOPS USING CodeSift when handed
 * everything — 3e1ec6c reverted exactly that after adoption fell by more than 90%.
 *
 * Measured 2026-08-29, before this existed: a Codex client on the daemon saw 90 tools where the
 * same build over stdio gives it 181, and `find_dead_code` did not exist as far as it was
 * concerned. The first fix front-loaded globally and handed Claude Code all 181 as a side effect —
 * trading one client's outage for the other's. Hence per request, and deliberately not remembered.
 */
describe("tool list is per client, on one shared daemon", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  async function toolsFor(url: string): Promise<string[]> {
    const c = new Client({ name: "probe", version: "1" }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    const list = await c.listTools();
    await c.close();
    return list.tools.map((t) => t.name);
  }

  it("gives a frozen-list client the full surface and everyone else the core one", async () => {
    const h = await startHttpServer({ port: 0 });
    close = h.close;

    const codex = await toolsFor(`${h.url}?client=codex`);
    const claude = await toolsFor(`${h.url}?client=claude`);

    expect(codex.length).toBeGreaterThan(claude.length * 2);
    expect(codex).toContain("find_dead_code");
    expect(claude).not.toContain("find_dead_code");
  }, 120_000);

  it("does NOT let one client's front-load leak into another's list", async () => {
    // The regression that made the first attempt unshippable. Order matters: codex first.
    const h = await startHttpServer({ port: 0 });
    close = h.close;

    const codexFirst = await toolsFor(`${h.url}?client=codex`);
    const claudeAfter = await toolsFor(`${h.url}?client=claude`);
    const codexAgain = await toolsFor(`${h.url}?client=codex`);

    expect(claudeAfter).not.toContain("find_dead_code");
    expect(claudeAfter.length).toBeLessThan(codexFirst.length);
    // And the frozen-list client keeps its surface across requests, not just the first.
    expect(codexAgain).toContain("find_dead_code");
  }, 120_000);

  it("treats a URL with no client as the conservative default", async () => {
    const h = await startHttpServer({ port: 0 });
    close = h.close;

    const none = await toolsFor(h.url);
    const claude = await toolsFor(`${h.url}?client=claude`);
    expect(none).not.toContain("find_dead_code");
    expect(none.length).toBe(claude.length);
  }, 120_000);
});

describe("clientFromUrl", () => {
  it("reads the client and ignores anything that is not one", () => {
    expect(clientFromUrl("/mcp?client=codex")).toBe("codex");
    expect(clientFromUrl("/mcp?cwd=%2Ftmp&client=Codex")).toBe("codex");
    expect(clientFromUrl("/mcp")).toBeUndefined();
    expect(clientFromUrl("/mcp?client=")).toBeUndefined();
  });

  it("refuses shapes that are not a client name", () => {
    // It selects a code path, so it is not a place for free text.
    expect(clientFromUrl("/mcp?client=" + encodeURIComponent("../../etc"))).toBeUndefined();
    expect(clientFromUrl("/mcp?client=" + "x".repeat(64))).toBeUndefined();
    expect(clientFromUrl("/mcp?client=9codex")).toBeUndefined();
  });
});
