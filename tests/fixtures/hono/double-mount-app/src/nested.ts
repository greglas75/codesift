import { Hono } from "hono";

const nested = new Hono();
nested.get("/hello", (c) => c.text("ok"));

export default nested;
