/**
 * Tree-sitter worker — isolates WASM parsing in a dedicated thread.
 *
 * Why this exists: web-tree-sitter's `parser.parse()` is a synchronous WASM
 * call. On pathological inputs (deeply nested AST, malformed source, certain
 * minified files) it can either hang the event loop indefinitely or crash
 * the Node process via a native segfault. Either failure mode kills the
 * entire MCP server and surfaces to clients as "Connection closed".
 *
 * By running parses in a worker:
 *  - A hang only blocks the worker; the pool can `terminate()` it and
 *    spawn a replacement without taking down the MCP server.
 *  - A native crash exits the worker process; the pool's `exit` handler
 *    fails any in-flight tasks and respawns. MCP main thread keeps serving.
 *
 * Scope is intentionally narrow: only tree-sitter paths (TypeScript,
 * JavaScript, Python, Go, Rust, Java, Ruby, PHP, CSS, Kotlin) go through
 * the worker. Markdown / Prisma / Astro / SQL / Conversation extractors
 * are pure regex/text — they can throw but cannot segfault, so they stay
 * in the main thread for simplicity and lower per-call overhead.
 */
import { parentPort } from "node:worker_threads";
import { parseFile } from "./parser-manager.js";
import { extractSymbols } from "./symbol-extractor.js";
import type { CodeSymbol } from "../types.js";

if (!parentPort) {
  throw new Error("parse-worker must be spawned with a parentPort");
}

interface WorkRequest {
  id: number;
  filePath: string;
  source: string;
  language: string;
  relPath: string;
  repoName: string;
}

interface WorkResponse {
  id: number;
  ok: boolean;
  symbols?: CodeSymbol[];
  error?: string;
}

parentPort.on("message", async (req: WorkRequest) => {
  try {
    const tree = await parseFile(req.filePath, req.source);
    if (!tree) {
      const resp: WorkResponse = { id: req.id, ok: true, symbols: [] };
      parentPort!.postMessage(resp);
      return;
    }
    const symbols = extractSymbols(
      tree,
      req.relPath,
      req.source,
      req.repoName,
      req.language,
    );
    // CodeSymbol is plain data — structured-clone friendly.
    const resp: WorkResponse = { id: req.id, ok: true, symbols };
    parentPort!.postMessage(resp);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const resp: WorkResponse = { id: req.id, ok: false, error: message };
    parentPort!.postMessage(resp);
  }
});
