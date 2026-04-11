import { Hono } from "hono";
import { logger } from "hono/logger";
import { authMiddleware, tenantMiddleware } from "./middleware/auth.js";
import usersRouter from "./routes/users.js";
import adminRouter from "./routes/admin.js";

const app = new Hono();

app.use("*", logger());
app.use("/api/*", authMiddleware);
app.use("/api/admin/*", tenantMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/users", usersRouter);
app.route("/api/admin", adminRouter);

export type AppType = typeof app;

export default app;
