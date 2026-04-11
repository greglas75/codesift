import { Hono } from "hono";

// Cloudflare signal: Bindings type references CF-specific types.
// NOTE: no wrangler.toml exists in this fixture — the only signal is the type.
type Bindings = {
  USERS_KV: KVNamespace;
  ASSETS: R2Bucket;
  DB: D1Database;
  TASK_QUEUE: Queue;
};

// Stub declarations so the fixture typechecks in isolation
declare class KVNamespace {}
declare class R2Bucket {}
declare class D1Database {}
declare class Queue {}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.json({ ok: true }));

export default app;
