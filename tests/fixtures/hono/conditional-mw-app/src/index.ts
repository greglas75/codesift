import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bearerAuth } from "hono/bearer-auth";

type Bindings = { USERNAME: string; PASSWORD: string; ADMIN_TOKEN: string };

const app = new Hono<{ Bindings: Bindings }>();

// Blog-style: basicAuth only for non-GET methods
app.use("/posts/*", async (c, next) => {
  if (c.req.method !== "GET") {
    const auth = basicAuth({ username: c.env.USERNAME, password: c.env.PASSWORD });
    return auth(c, next);
  }
  await next();
});

// Header-gated middleware: bearerAuth only when x-api-key is missing
app.use("/admin/*", async (c, next) => {
  if (!c.req.header("x-api-key")) {
    return bearerAuth({ token: c.env.ADMIN_TOKEN })(c, next);
  }
  await next();
});

// Path-gated (custom): log only for deep paths
app.use("/deep/*", async (c, next) => {
  if (c.req.path.startsWith("/deep/internal")) {
    return logDeep(c, next);
  }
  await next();
});

// Unconditional middleware (no applied_when expected)
app.use("/public/*", async (c, next) => {
  await next();
});

function logDeep(_c: unknown, next: () => Promise<void>): Promise<void> {
  return next();
}

app.get("/posts/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/posts", (c) => c.json({ ok: true }, 201));
app.get("/admin/users", (c) => c.json([]));
app.get("/deep/internal/data", (c) => c.json({}));
app.get("/public/health", (c) => c.json({ ok: true }));

export default app;
