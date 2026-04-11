import { Hono } from "hono";

const adminRouter = new Hono();

adminRouter.get("/settings", (c) => c.json({ theme: "dark" }));
adminRouter.put("/settings", async (c) => {
  const body = await c.req.json();
  return c.json(body);
});
adminRouter.get("/users", (c) => c.json({ admin_users: [] }));
adminRouter.delete("/users/:id", (c) => {
  return c.json({ deleted: c.req.param("id") });
});

export default adminRouter;
