import type { MiddlewareHandler } from "hono";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const token = c.req.header("authorization");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", token.replace("Bearer ", ""));
  await next();
};

export const tenantMiddleware: MiddlewareHandler = async (c, next) => {
  c.set("tenantId", "t1");
  await next();
};
