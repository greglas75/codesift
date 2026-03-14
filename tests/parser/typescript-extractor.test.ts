import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractTypeScriptSymbols } from "../../src/parser/extractors/typescript.js";

beforeAll(async () => {
  await initParser();
});

describe("extractTypeScriptSymbols — constants (Gap 1)", () => {
  it("extracts SCREAMING_CASE const as 'constant' kind", async () => {
    const source = `const MAX_RETRIES = 3;
const API_BASE_URL = "https://example.com";
const CACHE_TTL_SECONDS = 300;
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "config.ts", source, "test-repo");

    const maxRetries = symbols.find((s) => s.name === "MAX_RETRIES");
    expect(maxRetries).toBeDefined();
    expect(maxRetries!.kind).toBe("constant");

    const apiBaseUrl = symbols.find((s) => s.name === "API_BASE_URL");
    expect(apiBaseUrl).toBeDefined();
    expect(apiBaseUrl!.kind).toBe("constant");

    const cacheTtl = symbols.find((s) => s.name === "CACHE_TTL_SECONDS");
    expect(cacheTtl).toBeDefined();
    expect(cacheTtl!.kind).toBe("constant");
  });

  it("keeps camelCase const as 'variable' kind", async () => {
    const source = `const maxRetries = 3;
const apiBaseUrl = "https://example.com";
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "config.ts", source, "test-repo");

    expect(symbols.every((s) => s.kind === "variable")).toBe(true);
  });

  it("keeps arrow function const as 'function' regardless of casing", async () => {
    const source = `const MY_HANDLER = () => {};
const fetchData = async () => {};
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "handlers.ts", source, "test-repo");

    expect(symbols.find((s) => s.name === "MY_HANDLER")!.kind).toBe("function");
    expect(symbols.find((s) => s.name === "fetchData")!.kind).toBe("function");
  });

  it("does not treat let SCREAMING_CASE as constant", async () => {
    const source = `let MAX_COUNT = 10;
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "vars.ts", source, "test-repo");

    const maxCount = symbols.find((s) => s.name === "MAX_COUNT");
    expect(maxCount).toBeDefined();
    expect(maxCount!.kind).toBe("variable");
  });

  it("does not treat single-letter uppercase as constant", async () => {
    const source = `const A = 1;
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "single.ts", source, "test-repo");

    const a = symbols.find((s) => s.name === "A");
    expect(a).toBeDefined();
    // Single letter doesn't match /^[A-Z][A-Z0-9_]+$/ (requires 2+ chars)
    expect(a!.kind).toBe("variable");
  });
});

describe("extractTypeScriptSymbols — test hooks (Gap 2)", () => {
  it("extracts beforeEach as 'test_hook' kind", async () => {
    const source = `beforeEach(() => {
  jest.clearAllMocks();
});
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "test.spec.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "beforeEach");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("test_hook");
  });

  it("extracts afterEach as 'test_hook' kind", async () => {
    const source = `afterEach(async () => {
  await cleanup();
});
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "test.spec.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "afterEach");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("test_hook");
  });

  it("extracts beforeAll and afterAll as 'test_hook' kind", async () => {
    const source = `beforeAll(() => {
  setupDB();
});

afterAll(() => {
  teardownDB();
});
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "test.spec.ts", source, "test-repo");

    const hooks = symbols.filter((s) => s.kind === "test_hook");
    expect(hooks).toHaveLength(2);
    expect(hooks.map((h) => h.name).sort()).toEqual(["afterAll", "beforeAll"]);
  });

  it("extracts test hooks inside describe blocks with correct parent", async () => {
    const source = `describe("UserService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should create user", () => {
    expect(true).toBe(true);
  });
});
`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "user.test.ts", source, "test-repo");

    const suite = symbols.find((s) => s.kind === "test_suite");
    expect(suite).toBeDefined();

    const hook = symbols.find((s) => s.kind === "test_hook");
    expect(hook).toBeDefined();
    expect(hook!.name).toBe("beforeEach");
    expect(hook!.parent).toBe(suite!.id);

    const testCase = symbols.find((s) => s.kind === "test_case");
    expect(testCase).toBeDefined();
    expect(testCase!.parent).toBe(suite!.id);
  });
});
