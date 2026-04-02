import type { ChildProcess } from "node:child_process";

const REQUEST_TIMEOUT_MS = 10_000;

export function encodeMessage(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

export function decodeMessages(buffer: Buffer<ArrayBuffer>): {
  messages: unknown[];
  remaining: Buffer<ArrayBuffer>;
} {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd === -1) break;

    const header = buffer.subarray(offset, headerEnd).toString("utf-8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;

    const contentLength = parseInt(match[1]!, 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (bodyEnd > buffer.length) break;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
    try {
      messages.push(JSON.parse(body));
    } catch {
      // skip malformed JSON
    }
    offset = bodyEnd;
  }

  return { messages, remaining: Buffer.from(buffer.subarray(offset)) };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private openFiles = new Set<string>();

  constructor(private process: ChildProcess) {
    process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stderr?.on("data", () => {
      // LSP servers log to stderr — ignore
    });
    process.on("exit", () => {
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });
  }

  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          references: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
          rename: { dynamicRegistration: false, prepareSupport: true },
          callHierarchy: { dynamicRegistration: false },
        },
      },
    });
    this.notify("initialized", {});
    return result;
  }

  async request<T = unknown>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.process.stdin?.write(encodeMessage(body));
    });
  }

  notify(method: string, params: object): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.process.stdin?.write(encodeMessage(body));
  }

  async openFile(uri: string, content: string, languageId: string): Promise<void> {
    if (this.openFiles.has(uri)) return;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: content },
    });
    this.openFiles.add(uri);
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", {});
      this.notify("exit", {});
    } catch {
      this.process.kill("SIGTERM");
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.from(Buffer.concat([this.buffer, chunk]));
    const { messages, remaining } = decodeMessages(this.buffer);
    this.buffer = remaining;

    for (const msg of messages) {
      const rpc = msg as { id?: number; result?: unknown; error?: { message: string } };
      if (rpc.id !== undefined && this.pending.has(rpc.id)) {
        const req = this.pending.get(rpc.id)!;
        this.pending.delete(rpc.id);
        clearTimeout(req.timer);
        if (rpc.error) {
          req.reject(new Error(rpc.error.message));
        } else {
          req.resolve(rpc.result);
        }
      }
    }
  }
}
