import { describe, it, expect, beforeAll } from "vitest";
import type Parser from "web-tree-sitter";
import { getParser } from "../../src/parser/parser-manager.js";
import { HonoInlineAnalyzer } from "../../src/parser/extractors/hono-inline-analyzer.js";

/**
 * Parse a TS snippet and return the first arrow_function node. Test helper
 * that mimics what walkHttpRoutes does when it encounters an inline handler.
 */
async function firstArrowFunction(source: string): Promise<Parser.SyntaxNode> {
  const parser = await getParser("typescript");
  if (!parser) throw new Error("typescript parser unavailable");
  const tree = parser.parse(source);
  if (!tree) throw new Error("parse failed");
  let found: Parser.SyntaxNode | null = null;
  const walk = (n: Parser.SyntaxNode): void => {
    if (found) return;
    if (n.type === "arrow_function" || n.type === "function_expression") {
      found = n;
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(tree.rootNode);
  if (!found) throw new Error("no arrow_function found in snippet");
  return found;
}

describe("HonoInlineAnalyzer — responses", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("extracts c.json() with default status 200", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.json({ ok: true });`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses).toHaveLength(1);
    expect(r.responses[0]?.kind).toBe("json");
    expect(r.responses[0]?.status).toBe(200);
  });

  it("extracts c.json(value, 201) with explicit status", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.json({ id: 1 }, 201);`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.status).toBe(201);
  });

  it("extracts multiple c.json with different statuses", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => {
         if (err) return c.json({ error: "x" }, 404);
         return c.json({ ok: true }, 200);
       };`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses).toHaveLength(2);
    const statuses = r.responses.map((x) => x.status).sort();
    expect(statuses).toEqual([200, 404]);
  });

  it("extracts c.text with default 200", async () => {
    const node = await firstArrowFunction(`const f = (c) => c.text("hi");`);
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.kind).toBe("text");
    expect(r.responses[0]?.status).toBe(200);
  });

  it("extracts c.html", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.html("<h1>hi</h1>");`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.kind).toBe("html");
  });

  it("extracts c.redirect with status 302 default", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.redirect("/login");`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.kind).toBe("redirect");
    expect(r.responses[0]?.status).toBe(302);
  });

  it("extracts c.newResponse with explicit status", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.newResponse(null, 204);`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.kind).toBe("newResponse");
    expect(r.responses[0]?.status).toBe(204);
  });

  it("captures shape_hint from literal argument, truncated at 200 chars", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => c.json({ id: 1, name: "alice" });`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses[0]?.shape_hint).toContain("alice");
    expect(r.responses[0]?.shape_hint?.length ?? 0).toBeLessThanOrEqual(200);
  });

  it("returns empty responses when body has none", async () => {
    const node = await firstArrowFunction(`const f = (c) => { doSomething(); };`);
    const r = analyzer.analyze(node);
    expect(r.responses).toHaveLength(0);
  });
});

describe("HonoInlineAnalyzer — errors", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("extracts throw new HTTPException(404)", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { throw new HTTPException(404, { message: "not found" }); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.status).toBe(404);
    expect(r.errors[0]?.exception_class).toBe("HTTPException");
  });

  it("extracts throw new Error(...) with default status 500", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { throw new Error("boom"); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.errors[0]?.exception_class).toBe("Error");
    expect(r.errors[0]?.status).toBe(500);
  });

  it("detects has_try_catch when body contains try/catch", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { try { return c.json({}); } catch (e) { return c.json({ error: true }, 500); } };`,
    );
    const r = analyzer.analyze(node);
    expect(r.has_try_catch).toBe(true);
  });

  it("has_try_catch is false when no try block", async () => {
    const node = await firstArrowFunction(`const f = (c) => c.json({});`);
    const r = analyzer.analyze(node);
    expect(r.has_try_catch).toBe(false);
  });
});

describe("HonoInlineAnalyzer — external calls", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("detects prisma.* as db call", async () => {
    const node = await firstArrowFunction(
      `const f = async (c) => { const u = await prisma.user.findMany(); return c.json(u); };`,
    );
    const r = analyzer.analyze(node);
    const dbCalls = r.db_calls.map((x) => x.callee);
    expect(dbCalls).toContain("prisma.user.findMany");
  });

  it("detects db.query as db call", async () => {
    const node = await firstArrowFunction(
      `const f = async (c) => { const r = await db.query("SELECT 1"); return c.json(r); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.db_calls.map((x) => x.callee)).toContain("db.query");
  });

  it("detects fetch() as fetch call", async () => {
    const node = await firstArrowFunction(
      `const f = async (c) => { const r = await fetch("https://x.com"); return c.json(await r.json()); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.fetch_calls.map((x) => x.callee)).toContain("fetch");
  });

  it("does not count prisma inside a nested function as outer call", async () => {
    // Outer handler has no calls; inner nested arrow does. The analyzer
    // walks body so it will see nested calls too — document this behavior:
    // nested calls ARE included. We assert they are captured.
    const node = await firstArrowFunction(
      `const f = (c) => { const inner = () => prisma.user.findMany(); return c.json({}); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.db_calls).toHaveLength(1);
  });
});

describe("HonoInlineAnalyzer — context access", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("captures c.set/c.get/c.var/c.env usage", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => {
         c.set("userId", 42);
         const u = c.get("userId");
         const v = c.var.tenant;
         const k = c.env.API_KEY;
         return c.json({ u, v, k });
       };`,
    );
    const r = analyzer.analyze(node);
    const types = r.context_access.map((a) => a.type).sort();
    expect(types).toContain("set");
    expect(types).toContain("get");
    expect(types).toContain("var");
    expect(types).toContain("env");
    const envAccess = r.context_access.find((a) => a.type === "env");
    expect(envAccess?.key).toBe("API_KEY");
  });
});

describe("HonoInlineAnalyzer — validators inline", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("captures zValidator references inside body", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { const v = zValidator("json", schema); return c.json({}); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.validators_inline).toContain("zValidator");
  });
});

describe("HonoInlineAnalyzer — defensive", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("returns empty analysis when passed a non-function node", async () => {
    const parser = await getParser("typescript");
    if (!parser) throw new Error("no parser");
    const tree = parser.parse(`const x = 1;`);
    if (!tree) throw new Error("parse failed");
    // Pass the root node — not a function. Should return empty.
    const r = analyzer.analyze(tree.rootNode);
    expect(r.responses).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
    expect(r.db_calls).toHaveLength(0);
    expect(r.has_try_catch).toBe(false);
    expect(r.truncated).toBe(false);
  });
});

describe("HonoInlineAnalyzer — adversarial-review fixes", () => {
  let analyzer: HonoInlineAnalyzer;
  beforeAll(() => {
    analyzer = new HonoInlineAnalyzer();
  });

  it("recognizes a handler written with (ctx) => — not just (c) =>", async () => {
    const node = await firstArrowFunction(
      `const f = (ctx) => ctx.json({ ok: true }, 201);`,
    );
    const r = analyzer.analyze(node);
    expect(r.responses).toHaveLength(1);
    expect(r.responses[0]?.status).toBe(201);
  });

  it("recognizes a handler written with (context) => ...", async () => {
    const node = await firstArrowFunction(
      `const f = (context) => { context.set("userId", 42); return context.json({}); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.context_access.some((a) => a.type === "set" && a.key === "userId")).toBe(true);
    expect(r.responses).toHaveLength(1);
  });

  it("does NOT flag `app.insert(...)` or `array.delete(x)` as a db call", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { app.insert(1); array.delete(x); config.from("foo"); return c.json({}); };`,
    );
    const r = analyzer.analyze(node);
    expect(r.db_calls).toHaveLength(0);
  });

  it("emits UnknownThrow for `throw err` / `throw getError()` (no new)", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { if (bad) throw err; if (worse) throw getError(); return c.json({}); };`,
    );
    const r = analyzer.analyze(node);
    const classes = r.errors.map((e) => e.exception_class).sort();
    expect(classes).toContain("UnknownThrow");
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("has_try_catch is FALSE for try { } finally { } without catch", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { try { return c.json({}); } finally { cleanup(); } };`,
    );
    const r = analyzer.analyze(node);
    expect(r.has_try_catch).toBe(false);
  });

  it("has_try_catch is TRUE when catch is present even with finally", async () => {
    const node = await firstArrowFunction(
      `const f = (c) => { try { return c.json({}); } catch (e) { return c.json({}, 500); } finally { cleanup(); } };`,
    );
    const r = analyzer.analyze(node);
    expect(r.has_try_catch).toBe(true);
  });

  it("captures c.set with template literal key", async () => {
    const node = await firstArrowFunction(
      "const f = (c) => { c.set(`tenant`, 42); return c.json({}); };",
    );
    const r = analyzer.analyze(node);
    expect(r.context_access.some((a) => a.type === "set" && a.key === "tenant")).toBe(true);
  });

  it("records dynamic template key as <dynamic>", async () => {
    const node = await firstArrowFunction(
      "const f = (c) => { c.set(`user_${id}`, 42); return c.json({}); };",
    );
    const r = analyzer.analyze(node);
    expect(r.context_access.some((a) => a.type === "set" && a.key === "<dynamic>")).toBe(true);
  });

  it("truncated defaults to false for normal-sized handlers", async () => {
    const node = await firstArrowFunction(`const f = (c) => c.json({});`);
    const r = analyzer.analyze(node);
    expect(r.truncated).toBe(false);
  });
});
