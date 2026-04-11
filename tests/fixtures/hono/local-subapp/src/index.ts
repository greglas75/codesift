import { Hono } from "hono";

// Blog-style: sub-app declared in the same file, not imported.
const middleware = new Hono();
middleware.use("/posts/*", async (c, next) => {
  await next();
});

const app = new Hono();

// mounts a LOCAL sub-app, not an imported one
app.route("/api", middleware);

app.get("/", (c) => c.json({ ok: true }));

export default app;
