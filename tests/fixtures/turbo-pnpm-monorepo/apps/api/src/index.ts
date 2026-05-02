import { Hono } from "hono";
import type { User } from "@org/shared";

export const app = new Hono();

app.get("/users", (c): { users: User[] } => {
  return c.json({ users: [] });
});
