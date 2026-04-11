import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HonoExtractor } from "../../src/parser/extractors/hono.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "hono");

describe("HonoExtractor — basic-app", () => {
  const basicEntry = path.join(FIXTURES, "basic-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("detects the `app` variable as a new Hono() instance", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.app_variables.app).toBeDefined();
    expect(model.app_variables.app?.variable_name).toBe("app");
    expect(model.app_variables.app?.created_via).toBe("new Hono");
    expect(model.app_variables.app?.base_path).toBe("");
  });

  it("extracts all 5 routes from the basic app", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.routes).toHaveLength(5);

    const paths = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      "GET /",
      "GET /health",
      "GET /users/:id",
      "PATCH /users/:id",
      "POST /users",
    ]);
  });

  it("records the entry file as absolute path in files_used", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.files_used).toContain(basicEntry);
    expect(model.entry_file).toBe(basicEntry);
  });

  it("marks extraction_status as partial (middleware/context/openapi not yet extracted)", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.extraction_status).toBe("partial");
    expect(model.skip_reasons.middleware_not_extracted).toBe(1);
  });

  it("every route references the same owner_var", async () => {
    const model = await extractor.parse(basicEntry);
    for (const route of model.routes) {
      expect(route.owner_var).toBe("app");
    }
  });
});
