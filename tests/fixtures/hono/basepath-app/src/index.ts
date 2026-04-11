import { Hono } from "hono";

const app = new Hono();

// basePath chain — AC-R6
const v1 = app.basePath("/v1");
v1.get("/users", (c) => c.json({ users: [] }));
v1.post("/users", async (c) => {
  const body = await c.req.json();
  return c.json(body, 201);
});

// app.all() catch-all — AC-R3
app.all("/api/*", (c) => c.json({ catchAll: true }));

// app.on() multi-method — AC-R4
app.on(["GET", "POST"], "/form", (c) => c.text("form"));

// Regex constraint parameter — AC-R5
app.get("/posts/:id{[0-9]+}", (c) => {
  return c.json({ id: c.req.param("id") });
});

// app.mount() non-Hono — AC-R7
const legacyHandler = (req: Request) => new Response("legacy");
app.mount("/legacy", legacyHandler);

// Normal route
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
