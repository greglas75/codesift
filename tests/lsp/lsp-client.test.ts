import { describe, it, expect } from "vitest";
import { encodeMessage, decodeMessages } from "../../src/lsp/lsp-client.js";

describe("LSP JSON-RPC encoding", () => {
  it("encodes a message with Content-Length header", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test", params: {} });
    const encoded = encodeMessage(body);
    expect(encoded).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  it("decodes a complete message from buffer", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const { messages, remaining } = decodeMessages(Buffer.from(raw));
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(remaining.length).toBe(0);
  });

  it("handles partial message (incomplete body)", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const partial = header + body.slice(0, 5);
    const { messages, remaining } = decodeMessages(Buffer.from(partial));
    expect(messages.length).toBe(0);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("decodes multiple messages in one buffer", () => {
    const msg1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" });
    const msg2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b" });
    const raw = `Content-Length: ${Buffer.byteLength(msg1)}\r\n\r\n${msg1}Content-Length: ${Buffer.byteLength(msg2)}\r\n\r\n${msg2}`;
    const { messages } = decodeMessages(Buffer.from(raw));
    expect(messages.length).toBe(2);
  });
});
