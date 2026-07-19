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

const HOST = process.env.COLLECTOR_HOST ?? "127.0.0.1"; // loopback-only by default
const PORT = Number(process.env.COLLECTOR_PORT ?? 5599);
const TOKEN = process.env.CODESIFT_COLLECTOR_TOKEN ?? "";
const DATA_DIR = process.env.COLLECTOR_DATA_DIR ?? join(homedir(), "telemetry-collector", "data");
const MAX_BODY = Number(process.env.COLLECTOR_MAX_BODY ?? 262_144); // 256 KB
const NAMESPACES = new Set(["codesift", "zuvo"]);

// Simple per-anon_id rate limit: max N accepted requests per rolling window.
const RL_MAX = Number(process.env.COLLECTOR_RL_MAX ?? 120);
const RL_WINDOW_MS = Number(process.env.COLLECTOR_RL_WINDOW_MS ?? 60_000);
const rl = new Map(); // anon_id -> { count, resetAt }

function rateLimited(anonId, now) {
  if (!anonId) return false; // unknown id → don't block (schema-tolerant)
  let e = rl.get(anonId);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + RL_WINDOW_MS };
    rl.set(anonId, e);
  }
  e.count++;
  return e.count > RL_MAX;
}
// Opportunistic cleanup so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rl) if (now > v.resetAt) rl.delete(k);
}, RL_WINDOW_MS).unref();

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

  // Auth: constant-ish comparison. Empty configured token => refuse all (safe default).
  if (!TOKEN || req.headers["x-api-key"] !== TOKEN) return send(res, 401, { error: "unauthorized" });

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
    const anonId = payload && typeof payload.anon_id === "string" ? payload.anon_id : "";
    if (rateLimited(anonId, now)) return send(res, 429, { error: "rate limited" });

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
  if (!TOKEN) console.error("[collector] WARNING: CODESIFT_COLLECTOR_TOKEN unset — all ingest requests will 401.");
});
