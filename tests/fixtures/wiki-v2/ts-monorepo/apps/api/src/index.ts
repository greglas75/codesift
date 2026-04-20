import { Hono } from "hono";
import { listUsers } from "./routes/users.js";

export const app = new Hono();
app.get("/users", listUsers);
