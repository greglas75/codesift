import { Hono } from "hono";

const usersRouter = new Hono();

usersRouter.get("/", (c) => c.json({ users: [] }));
usersRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ id, name: "alice" });
});
usersRouter.post("/", async (c) => {
  const body = await c.req.json();
  return c.json({ id: "u1", ...body }, 201);
});

export type UserRoutes = typeof usersRouter;

export default usersRouter;
