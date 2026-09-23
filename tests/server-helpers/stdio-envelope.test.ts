import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/server";
import { envelopeClientName, observeInbound } from "../../src/server-helpers/stdio-envelope.js";

const envelope = (name: unknown) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name, version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

describe("envelopeClientName", () => {
  it("reads the client name from a 2026-07-28 request envelope", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope("codex-mcp-client") } };
    expect(envelopeClientName(message)).toBe("codex-mcp-client");
  });

  // A 2025-era initialize names the client in params.clientInfo — that path is served by
  // oninitialized, and must not be double-counted here.
  it("ignores a legacy initialize", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-client" } } };
    expect(envelopeClientName(message)).toBeUndefined();
  });

  // The protocol-version key IS the claim; clientInfo alone under _meta is not an envelope.
  it("requires the protocol-version claim", () => {
    const message = {
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/clientInfo": { name: "codex-mcp-client" } } },
    };
    expect(envelopeClientName(message)).toBeUndefined();
  });

  it("returns undefined for malformed or absent identity", () => {
    for (const message of [
      null, "x", [], { params: null }, { params: { _meta: [] } },
      { params: { _meta: envelope("") } }, { params: { _meta: envelope(42) } },
      { params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } },
    ]) {
      expect(envelopeClientName(message)).toBeUndefined();
    }
  });
});

function fakeTransport() {
  const inner: Transport & { started: boolean } = {
    started: false,
    start: async () => { inner.started = true; },
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return inner;
}

describe("observeInbound", () => {
  it("shows each message to the observer before the owner", async () => {
    const inner = fakeTransport();
    const order: string[] = [];
    const outer = observeInbound(inner, () => order.push("observe"), () => {});
    outer.onmessage = () => order.push("owner");
    await outer.start();
    expect(inner.started).toBe(true);
    inner.onmessage?.({ jsonrpc: "2.0", method: "x" } as never);
    expect(order).toEqual(["observe", "owner"]);
  });

  // An observer bug must never cost the client its message.
  it("still delivers when the observer throws", async () => {
    const inner = fakeTransport();
    const delivered = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outer = observeInbound(inner, () => { throw new Error("boom"); }, () => {});
    outer.onmessage = delivered;
    await outer.start();
    inner.onmessage?.({ jsonrpc: "2.0", method: "x" } as never);
    expect(delivered).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("propagates close to both the owner and onClosed, and forwards send/close", async () => {
    const inner = fakeTransport();
    const onClosed = vi.fn();
    const ownerClose = vi.fn();
    const outer = observeInbound(inner, () => {}, onClosed);
    outer.onclose = ownerClose;
    await outer.start();
    inner.onclose?.();
    expect(ownerClose).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();

    await outer.send({ jsonrpc: "2.0", id: 1, result: {} } as never);
    await outer.close();
    expect(inner.send).toHaveBeenCalledOnce();
    expect(inner.close).toHaveBeenCalledOnce();
  });

  // serveStdio swallows a rejected start; without this hook a dead transport looks "started".
  it("reports a failed start through onStartFailed and still rejects", async () => {
    const inner = fakeTransport();
    inner.start = async () => { throw new Error("stdin gone"); };
    const failed = vi.fn();
    const outer = observeInbound(inner, () => {}, () => {}, { onStartFailed: failed });
    await expect(outer.start()).rejects.toThrow("stdin gone");
    expect(failed).toHaveBeenCalledOnce();
  });

  it("runs onClosed even when the owner's close handler throws", async () => {
    const inner = fakeTransport();
    const onClosed = vi.fn();
    const outer = observeInbound(inner, () => {}, onClosed);
    outer.onclose = () => { throw new Error("owner broke"); };
    await outer.start();
    expect(() => inner.onclose?.()).toThrow("owner broke");
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
