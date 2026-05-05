import { Hono } from "hono";
import usersApp from "./users.js";

const app = new Hono();
app.route("/api/v1", usersApp);
app.route("/api/v2", usersApp);

export default app;
