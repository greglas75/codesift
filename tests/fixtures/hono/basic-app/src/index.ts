import { Hono } from "hono";
import { logger } from "hono/logger";

const app = new Hono();

app.use("*", logger());
app.use("/users/*", async (c, next) => {
  const token = c.req.header("authorization");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/", (c) => c.text("hello"));
app.get("/health", (c) => c.json({ status: "ok" }));
app.post("/users", async (c) => {
  const body = await c.req.json();
  return c.json({ id: "u1", ...body }, 201);
});
app.get("/users/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ id, name: "alice" });
});
app.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  return c.json({ id, ...body });
});

export default app;
