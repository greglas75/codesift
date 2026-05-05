import { Hono } from "hono";
import nested from "./nested.js";

const users = new Hono();
users.get("/list", (c) => c.json([]));
users.route("/nested-mount", nested);

export default users;
