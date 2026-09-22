/**
 * Client identity for a stdio connection that never sends `initialize`.
 *
 * MCP 2026-07-28 removed the `initialize` / `notifications/initialized` handshake: a modern client
 * opens with `server/discover` or goes straight to `tools/list`, and names itself in every request's
 * `_meta` envelope instead. Two things in `runStdio` hung off `oninitialized` — front-loading the
 * tool surface for frozen-list hosts (Codex) and hook auto-install — and on a modern connection that
 * callback never fires. Measured against the 0.17.0 build with a 2026-07-28 Codex opening: 60 tools
 * instead of 181, and `server/discover` answered `Method not found`.
 *
 * The envelope is read at the WIRE, before the SDK dispatches the message, because front-loading
 * only works if it lands before the host's first `tools/list` is answered — the same constraint that
 * put it in `oninitialized` on the legacy path.
 */
import type { Transport } from "@modelcontextprotocol/server";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The client name a 2026-07-28 request declares in its `_meta` envelope, or undefined when the
 * message carries no envelope claim (a 2025-era message, a response, a notification without one).
 */
export function envelopeClientName(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const params = message["params"];
  if (!isRecord(params)) return undefined;
  const meta = params["_meta"];
  if (!isRecord(meta) || !(PROTOCOL_VERSION_META_KEY in meta)) return undefined;
  const info = meta[CLIENT_INFO_META_KEY];
  if (!isRecord(info)) return undefined;
  const name = info["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Wrap a transport so `observe` sees every inbound message before whoever owns the transport does,
 * and `onClosed` fires when the wire closes. `serveStdio` takes ownership of the transport's
 * callbacks, so observing has to happen one layer below it.
 */
export function observeInbound(
  inner: Transport,
  observe: (message: unknown) => void,
  onClosed: () => void,
): Transport {
  const outer: Transport = {
    start: async () => {
      inner.onmessage = (message, extra) => {
        try {
          observe(message);
        } catch (err) {
          console.error("[codesift] inbound observer failed:", err);
        }
        outer.onmessage?.(message, extra);
      };
      inner.onerror = (error) => outer.onerror?.(error);
      inner.onclose = () => {
        outer.onclose?.();
        onClosed();
      };
      await inner.start();
    },
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
  };
  return outer;
}
