import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ deployed: "fly.io" }));

export default app;
