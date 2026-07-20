#!/usr/bin/env node
// Unified telemetry collector for codesift + zuvo (spec §5). Zero dependencies —
// runs with a bare Node on coding-vps. Loopback-only; TLS is terminated by the
// reverse proxy in front. Writes JSONL per namespace per UTC day. Never stores
// client IPs in the data files (IP lives only in the proxy access log).
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { clientKey, RateLimiter } from "./ratelimit.mjs";

const HOST = process.env.COLLECTOR_HOST ?? "127.0.0.1"; // loopback-only by default
const PORT = Number(process.env.COLLECTOR_PORT ?? 5599);
// Secret token gates the FLEET / full-detail data and the zuvo namespace.
// Anonymous codesift ingest is intentionally open (validated + rate-limited)
// so the public install-base can send the allowlisted aggregate without a
// shared secret baked into the npm package.
const SECRET = process.env.CODESIFT_COLLECTOR_TOKEN ?? "";
const DATA_DIR = process.env.COLLECTOR_DATA_DIR ?? join(homedir(), "telemetry-collector", "data");
const MAX_BODY = Number(process.env.COLLECTOR_MAX_BODY ?? 262_144); // 256 KB
const NAMESPACES = new Set(["codesift", "zuvo"]);

// Per-CLIENT-IP rate limit (see ratelimit.mjs). Keyed on the proxy-observed IP,
// NOT the client-supplied anon_id — an id-keyed limit was trivially bypassed by
// omitting/rotating anon_id on the open endpoint.
const RL_MAX = Number(process.env.COLLECTOR_RL_MAX ?? 120);
const RL_WINDOW_MS = Number(process.env.COLLECTOR_RL_WINDOW_MS ?? 60_000);
const limiter = new RateLimiter({ max: RL_MAX, windowMs: RL_WINDOW_MS });
// Opportunistic cleanup so the map can't grow unbounded.
setInterval(() => limiter.sweep(Date.now()), RL_WINDOW_MS).unref();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function appendRecord(namespace, record) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(DATA_DIR, namespace);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${day}.jsonl`), JSON.stringify(record) + "\n", "utf-8");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

  const m = req.method === "POST" && /^\/ingest\/([a-z0-9_-]+)$/.exec(req.url ?? "");
  if (!m) return send(res, 404, { error: "not found" });
  const namespace = m[1];
  if (!NAMESPACES.has(namespace)) return send(res, 404, { error: "unknown namespace" });

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: "payload too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let payload;
    try {
      let buf = Buffer.concat(chunks);
      const enc = String(req.headers["content-encoding"] ?? "");
      if (enc.includes("gzip")) buf = gunzipSync(buf);
      payload = JSON.parse(buf.toString("utf-8"));
    } catch {
      return send(res, 400, { error: "invalid json" });
    }
    const now = Date.now();
    // Rate-limit on the proxy-observed client IP, never on the client-supplied
    // anon_id (omit/rotate = bypass on the open endpoint). No-IP → shared bucket.
    const _ck = clientKey(req);
    // Diagnostic (stdout only, NOT persisted to the data files): who hits the open
    // endpoint. Log the best-available origin — CF-Connecting-IP (truest when behind
    // Cloudflare), the full X-Forwarded-For chain, and the raw socket peer.
    console.log(
      `[collector] ${namespace} anon=${payload && typeof payload.anon_id === "string" ? payload.anon_id : "(none)"}` +
      ` tools=${Array.isArray(payload?.tools) ? payload.tools.length : "?"}` +
      ` cf=${req.headers["cf-connecting-ip"] ?? "-"} xff=${req.headers["x-forwarded-for"] ?? "-"} peer=${req.socket?.remoteAddress ?? "-"} key=${_ck}`,
    );
    if (limiter.hit(_ck, now)) return send(res, 429, { error: "rate limited" });

    // Authorize: zuvo + full-detail codesift require the secret; anonymous
    // codesift ingest is open but must look like an allowlisted L1 aggregate.
    const key = req.headers["x-api-key"] ?? "";
    const isFull = payload && payload.level === "full";
    if (namespace === "zuvo" || isFull) {
      if (!SECRET || key !== SECRET) return send(res, 401, { error: "unauthorized" });
    } else if (
      !payload ||
      typeof payload.anon_id !== "string" || !payload.anon_id ||
      !Array.isArray(payload.tools) || payload.tools.length === 0
    ) {
      // Reject noise: a real client always carries anon_id + >=1 tool aggregate
      // (it never POSTs an empty flush). Empty/anon-less bodies are scanners.
      return send(res, 400, { error: "not an anonymous L1 payload" });
    }

    // Schema-tolerant: accept unknown fields & unknown schema_version (forward-compat).
    if (payload && typeof payload.schema_version === "number" && payload.schema_version > 1) {
      console.log(`[collector] ${namespace}: newer schema_version=${payload.schema_version} (accepted)`);
    }
    // Store server-side receipt time; NO ip persisted.
    const record = { received_at: now, namespace, payload };
    try {
      await appendRecord(namespace, record);
    } catch (err) {
      console.error(`[collector] append failed: ${err?.message ?? err}`);
      return send(res, 500, { error: "write failed" });
    }
    send(res, 200, { ok: true });
  });
  req.on("error", () => { if (!res.writableEnded) send(res, 400, { error: "request error" }); });
});

server.listen(PORT, HOST, () => {
  console.log(`[collector] listening on ${HOST}:${PORT} → ${DATA_DIR} (namespaces: ${[...NAMESPACES].join(", ")})`);
  if (!SECRET) console.error("[collector] WARNING: CODESIFT_COLLECTOR_TOKEN unset — zuvo + full-detail ingest will 401 (anonymous codesift stays open).");
});
