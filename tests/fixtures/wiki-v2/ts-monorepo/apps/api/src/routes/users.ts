import type { Context } from "hono";

export async function listUsers(c: Context) {
  return c.json([{ id: 1, name: "Alice" }]);
}

export class UserController {
  async list() {
    return [];
  }
}
