import { createFactory } from "hono/factory";

type Env = {
  Bindings: {
    DATABASE_URL: string;
    KV: KVNamespace;
    AUTH_SECRET: string;
  };
};

const factory = createFactory<Env>();
const api = factory.createApp();

api.get("/ping", (c) => c.json({ pong: true }));
api.get("/env", (c) => {
  const { DATABASE_URL } = c.env;
  return c.json({ db: DATABASE_URL });
});
api.post("/data", async (c) => {
  const body = await c.req.json();
  return c.json({ stored: body }, 201);
});

export default api;
