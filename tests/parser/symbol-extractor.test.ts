import { extractSymbols, tokenizeIdentifier, makeSymbolId } from "../../src/parser/symbol-extractor.js";
import { initParser, getParser } from "../../src/parser/parser-manager.js";

beforeAll(async () => {
  await initParser();
});

describe("extractSymbols", () => {
  it("routes typescript to the TypeScript extractor", async () => {
    const source = `function greet(name: string): string { return name; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "hello.ts", source, "test-repo", "typescript");

    expect(symbols.length).toBeGreaterThan(0);
    const fn = symbols.find((s) => s.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.file).toBe("hello.ts");
    expect(fn!.repo).toBe("test-repo");
  });

  it("routes tsx to the TypeScript extractor", async () => {
    const source = `function App() { return null; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "App.tsx", source, "test-repo", "tsx");

    expect(symbols.find((s) => s.name === "App")).toBeDefined();
  });

  it("routes known languages to their dedicated extractors without crashing", async () => {
    // Parse with typescript grammar, then route through each language's switch case.
    // Each dedicated extractor returns CodeSymbol[] — may find 0 symbols if grammar
    // doesn't match, but must not crash.
    const source = `function hello() { return 1; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);

    for (const lang of ["python", "go", "rust", "javascript", "php", "kotlin"]) {
      const symbols = extractSymbols(tree, `file.${lang}`, source, "test-repo", lang);
      expect(Array.isArray(symbols)).toBe(true);
    }
  });

  it("falls back to generic extractor for unknown language", async () => {
    // Parse valid TS source, then route via an unrecognized language name
    // to hit the default branch → extractGenericSymbols
    const source = `function findUser(id) { return id; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "app.rb", source, "test-repo", "unknown_lang");

    expect(Array.isArray(symbols)).toBe(true);
    // Generic extractor maps function_declaration → "function"
    const fn = symbols.find((s) => s.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.name).toBe("findUser");
  });

  it("returns different symbols for different language routes on same tree", async () => {
    // TypeScript extractor recognizes const/arrow/interface; generic does not
    const source = `const MAX_RETRIES = 3;\nfunction doWork() {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);

    const tsSymbols = extractSymbols(tree, "a.ts", source, "test-repo", "typescript");
    const genericSymbols = extractSymbols(tree, "a.ts", source, "test-repo", "unknown_lang");

    const tsNames = tsSymbols.map((s) => s.name).sort();
    const genericNames = genericSymbols.map((s) => s.name).sort();
    // TypeScript extractor finds both const and function
    expect(tsNames).toContain("MAX_RETRIES");
    expect(tsNames).toContain("doWork");
    // Generic extractor only recognizes function_declaration, not lexical_declaration
    expect(genericNames).toContain("doWork");
    expect(genericNames).not.toContain("MAX_RETRIES");
  });
});

describe("extractGenericSymbols (via default extractSymbols path)", () => {
  it("extracts function_declaration nodes", async () => {
    const source = `function processData(items) { return items; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "lib.ts", source, "test-repo", "unknown_lang");

    const fn = symbols.find((s) => s.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.name).toBe("processData");
    expect(fn!.file).toBe("lib.ts");
    expect(fn!.repo).toBe("test-repo");
    expect(fn!.start_line).toBe(1);
  });

  it("sets parent ID for nested class > method", async () => {
    const source = `class UserService {\n  findUser(id) { return id; }\n}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "service.ts", source, "test-repo", "unknown_lang");

    const cls = symbols.find((s) => s.kind === "class");
    const method = symbols.find((s) => s.kind === "method");

    expect(cls).toBeDefined();
    expect(method).toBeDefined();
    expect(cls!.name).toBe("UserService");
    expect(method!.name).toBe("findUser");
    expect(method!.parent).toBe(cls!.id);
  });

  it("does not set parent when node is at root level", async () => {
    const source = `function standalone() { return 1; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "top.ts", source, "test-repo", "unknown_lang");

    const fn = symbols.find((s) => s.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.parent).toBeUndefined();
  });

  it("returns empty array when tree has no recognized node types", async () => {
    // lexical_declaration is not in GENERIC_NODE_KIND_MAP
    const source = `const x = 1;\nconst y = 2;\n`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "simple.ts", source, "test-repo", "unknown_lang");

    expect(symbols).toEqual([]);
  });

  it("truncates source exceeding 5000 characters", async () => {
    const longBody = "a".repeat(6000);
    const source = `function big() { const s = "${longBody}"; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "big.ts", source, "test-repo", "unknown_lang");

    const fn = symbols.find((s) => s.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.source!.length).toBeLessThanOrEqual(5004); // 5000 + "..."
    expect(fn!.source!.endsWith("...")).toBe(true);
  });

  it("does not truncate source under 5000 characters", async () => {
    const source = `function small() { return 1; }`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "small.ts", source, "test-repo", "unknown_lang");

    const fn = symbols.find((s) => s.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.source).toBe(source);
    expect(fn!.source!.endsWith("...")).toBe(false);
  });

  it("populates tokens from the symbol name via tokenizeIdentifier", async () => {
    const source = `class MyDataProcessor {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "proc.ts", source, "test-repo", "unknown_lang");

    const cls = symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.tokens).toEqual(["my", "data", "processor"]);
  });

  it("all extracted symbols have well-formed fields", async () => {
    const source = `class UserService {\n  findUser(id) { return id; }\n}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractSymbols(tree, "service.ts", source, "test-repo", "unknown_lang");

    expect(symbols.length).toBeGreaterThan(0);
    for (const sym of symbols) {
      expect(sym.id).toContain("test-repo:service.ts:");
      expect(sym.repo).toBe("test-repo");
      expect(sym.file).toBe("service.ts");
      expect(Array.isArray(sym.tokens)).toBe(true);
      expect(typeof sym.source).toBe("string");
      expect(sym.start_line).toBeGreaterThan(0);
      expect(sym.end_line).toBeGreaterThanOrEqual(sym.start_line);
    }
  });
});

describe("tokenizeIdentifier", () => {
  it("splits camelCase into lowercase tokens", () => {
    expect(tokenizeIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits snake_case into lowercase tokens", () => {
    expect(tokenizeIdentifier("user_name")).toEqual(["user", "name"]);
  });

  it("splits leading uppercase acronym followed by PascalCase", () => {
    expect(tokenizeIdentifier("HTMLParser")).toEqual(["html", "parser"]);
  });

  it("splits mixed acronym in the middle of camelCase", () => {
    expect(tokenizeIdentifier("fetchAPIData")).toEqual(["fetch", "api", "data"]);
  });

  it("returns single-word identifier as one lowercase token", () => {
    expect(tokenizeIdentifier("simple")).toEqual(["simple"]);
  });

  it("strips leading underscores and returns remaining tokens", () => {
    expect(tokenizeIdentifier("__private")).toEqual(["private"]);
  });

  it("splits UPPER_SNAKE_CASE into lowercase tokens", () => {
    expect(tokenizeIdentifier("ALL_CAPS_CONST")).toEqual(["all", "caps", "const"]);
  });

  it("splits consecutive acronyms correctly", () => {
    expect(tokenizeIdentifier("XMLHttpRequest")).toEqual(["xml", "http", "request"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeIdentifier("")).toEqual([]);
  });
});

describe("makeSymbolId", () => {
  it("produces repo:file:name:line format", () => {
    const id = makeSymbolId("myrepo", "file.ts", "functionName", 10);
    expect(id).toBe("myrepo:file.ts:functionName:10");
  });

  it("produces different IDs for different start lines", () => {
    const id1 = makeSymbolId("repo", "src/index.ts", "init", 1);
    const id2 = makeSymbolId("repo", "src/index.ts", "init", 42);
    expect(id1).not.toBe(id2);
    expect(id1).toBe("repo:src/index.ts:init:1");
    expect(id2).toBe("repo:src/index.ts:init:42");
  });
});
