import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const getUserRoute = createRoute({
  method: "get",
  path: "/users/{id}",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: UserSchema },
      },
      description: "User found",
    },
    404: {
      description: "User not found",
    },
  },
});

const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ users: z.array(UserSchema) }),
        },
      },
      description: "List of users",
    },
  },
});

const app = new OpenAPIHono();

app.openapi(getUserRoute, (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id, name: "Alice" });
});

app.openapi(listUsersRoute, (c) => {
  return c.json({ users: [{ id: "1", name: "Alice" }] });
});

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
