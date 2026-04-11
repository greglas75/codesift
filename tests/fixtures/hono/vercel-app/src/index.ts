import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ deployed: "vercel" }));

export default app;
