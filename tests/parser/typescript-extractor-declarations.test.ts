import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractTypeScriptSymbols } from "../../src/parser/extractors/typescript.js";
import type { CodeSymbol } from "../../src/types.js";

beforeAll(async () => {
  await initParser();
});

/** Parse TS source and extract symbols — shared helper */
async function extract(source: string, filePath = "test.ts"): Promise<CodeSymbol[]> {
  const parser = await getParser("typescript");
  const tree = parser!.parse(source);
  return extractTypeScriptSymbols(tree, filePath, source, "test-repo");
}

// --- Function declarations ---

describe("extractTypeScriptSymbols — function declarations", () => {
  it("extracts named function as 'function' kind with correct lines", async () => {
    const source = `function greet(name: string): string {
  return "Hello " + name;
}`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("greet");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].start_line).toBe(1);
    expect(symbols[0].end_line).toBe(3);
  });

  it("captures function signature with params and return type", async () => {
    const source = `function add(a: number, b: number): number {
  return a + b;
}`;
    const symbols = await extract(source);

    // getSignature adds ": " + return_type text (which includes leading ": ")
    expect(symbols[0].signature).toBe("(a: number, b: number): : number");
  });

  it("captures function signature without return type", async () => {
    const source = `function log(msg: string) {
  console.log(msg);
}`;
    const symbols = await extract(source);

    expect(symbols[0].signature).toBe("(msg: string)");
  });

  it("captures JSDoc docstring from preceding comment", async () => {
    const source = `/** Adds two numbers */
function add(a: number, b: number): number {
  return a + b;
}`;
    const symbols = await extract(source);

    expect(symbols[0].docstring).toBe("/** Adds two numbers */");
  });

  it("captures line comment as docstring", async () => {
    const source = `// Helper for formatting
function formatName(first: string, last: string) {
  return first + " " + last;
}`;
    const symbols = await extract(source);

    expect(symbols[0].docstring).toBe("// Helper for formatting");
  });

  it("does not capture non-comment preceding sibling as docstring", async () => {
    const source = `const x = 1;
function noDoc() {}`;
    const symbols = await extract(source);

    const fn = symbols.find((s) => s.name === "noDoc");
    expect(fn).toBeDefined();
    expect(fn!.docstring).toBeUndefined();
  });
});

// --- Classes and methods ---

describe("extractTypeScriptSymbols — classes and methods", () => {
  it("extracts class with methods as parent-child", async () => {
    const source = `class UserService {
  findById(id: string) {
    return null;
  }
  create(data: object) {
    return data;
  }
}`;
    const symbols = await extract(source);

    const cls = symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("UserService");

    const methods = symbols.filter((s) => s.kind === "method");
    expect(methods).toHaveLength(2);
    expect(methods.map((m) => m.name).sort()).toEqual(["create", "findById"]);
    // Methods should reference class as parent
    expect(methods[0].parent).toBe(cls!.id);
    expect(methods[1].parent).toBe(cls!.id);
  });

  it("extracts abstract class and abstract method signatures", async () => {
    const source = `abstract class BaseRepo {
  abstract findAll(): Promise<any[]>;
  abstract save(item: any): Promise<void>;
}`;
    const symbols = await extract(source);

    const cls = symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("BaseRepo");

    const methods = symbols.filter((s) => s.kind === "method");
    expect(methods).toHaveLength(2);
    expect(methods.map((m) => m.name).sort()).toEqual(["findAll", "save"]);
    // Abstract methods still have parent
    expect(methods.every((m) => m.parent === cls!.id)).toBe(true);
  });

  it("extracts public field definitions inside class", async () => {
    const source = `class Config {
  host = "localhost";
  port = 3000;
}`;
    const symbols = await extract(source);

    const fields = symbols.filter((s) => s.kind === "field");
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.name).sort()).toEqual(["host", "port"]);

    const cls = symbols.find((s) => s.kind === "class");
    expect(fields.every((f) => f.parent === cls!.id)).toBe(true);
  });
});

// --- Type declarations ---

describe("extractTypeScriptSymbols — type declarations", () => {
  it("extracts interface as 'interface' kind", async () => {
    const source = `interface User {
  id: string;
  name: string;
}`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("User");
    expect(symbols[0].kind).toBe("interface");
  });

  it("extracts type alias as 'type' kind", async () => {
    const source = `type Status = "active" | "inactive" | "pending";`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Status");
    expect(symbols[0].kind).toBe("type");
  });

  it("extracts enum as 'enum' kind", async () => {
    const source = `enum Direction {
  Up,
  Down,
  Left,
  Right,
}`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Direction");
    expect(symbols[0].kind).toBe("enum");
  });
});

// --- Export statement unwrapping ---

describe("extractTypeScriptSymbols — export statements", () => {
  it("unwraps exported function declaration", async () => {
    const source = `export function doWork(input: string): boolean {
  return input.length > 0;
}`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("doWork");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].signature).toBe("(input: string): : boolean");
  });

  it("unwraps exported class with methods", async () => {
    const source = `export class Parser {
  parse(code: string) {
    return code;
  }
}`;
    const symbols = await extract(source);

    const cls = symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("Parser");

    const method = symbols.find((s) => s.kind === "method");
    expect(method).toBeDefined();
    expect(method!.name).toBe("parse");
    expect(method!.parent).toBe(cls!.id);
  });

  it("unwraps exported interface", async () => {
    const source = `export interface Config {
  port: number;
}`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Config");
    expect(symbols[0].kind).toBe("interface");
  });

  it("unwraps exported const (SCREAMING_CASE → constant)", async () => {
    const source = `export const MAX_SIZE = 1024;`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("MAX_SIZE");
    expect(symbols[0].kind).toBe("constant");
  });
});

// --- Test case extraction (it/test) ---

describe("extractTypeScriptSymbols — test case extraction", () => {
  it("extracts it() as 'test_case' with name from string argument", async () => {
    const source = `it("should return true for valid input", () => {
  expect(validate("hello")).toBe(true);
});`;
    const symbols = await extract(source, "validation.test.ts");

    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("test_case");
    expect(symbols[0].name).toBe("should return true for valid input");
  });

  it("extracts test() as 'test_case'", async () => {
    const source = `test("adds numbers correctly", () => {
  expect(add(1, 2)).toBe(3);
});`;
    const symbols = await extract(source, "math.test.ts");

    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("test_case");
    expect(symbols[0].name).toBe("adds numbers correctly");
  });

  it("extracts it.skip() as 'test_case'", async () => {
    const source = `it.skip("pending feature", () => {});`;
    const symbols = await extract(source, "feature.test.ts");

    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("test_case");
    expect(symbols[0].name).toBe("pending feature");
  });

  it("extracts it.todo() as 'test_case'", async () => {
    const source = `it.todo("should handle edge case");`;
    const symbols = await extract(source, "edge.test.ts");

    expect(symbols).toHaveLength(1);
    expect(symbols[0].kind).toBe("test_case");
    // it.todo has only a string arg, no callback — getTestName should still work
    expect(symbols[0].name).toBe("should handle edge case");
  });

  it("extracts describe.only() as 'test_suite'", async () => {
    const source = `describe.only("focused suite", () => {
  it("runs this test", () => {});
});`;
    const symbols = await extract(source, "focused.test.ts");

    const suite = symbols.find((s) => s.kind === "test_suite");
    expect(suite).toBeDefined();
    expect(suite!.name).toBe("focused suite");

    const test = symbols.find((s) => s.kind === "test_case");
    expect(test).toBeDefined();
    expect(test!.parent).toBe(suite!.id);
  });

  it("extracts it.each()() chained call as 'test_case'", async () => {
    const source = `it.each([1, 2, 3])("handles value %i", (val) => {
  expect(process(val)).toBeDefined();
});`;
    const symbols = await extract(source, "param.test.ts");

    expect(symbols).toHaveLength(1);
    const testCase = symbols.find((s) => s.kind === "test_case");
    expect(testCase).toBeDefined();
    expect(testCase!.name).toBe("handles value %i");
  });
});

// --- Symbol property correctness ---

describe("extractTypeScriptSymbols — symbol properties", () => {
  it("generates correct id format: repo:file:name:startLine", async () => {
    const source = `function hello() {}`;
    const symbols = await extract(source, "greet.ts");

    expect(symbols[0].id).toBe("test-repo:greet.ts:hello:1");
  });

  it("computes tokens from identifier name", async () => {
    const source = `function getUserById() {}`;
    const symbols = await extract(source);

    // tokenizeIdentifier("getUserById") → ["get", "user", "by", "id"]
    expect(symbols[0].tokens).toEqual(["get", "user", "by", "id"]);
  });

  it("includes source text of the symbol", async () => {
    const source = `function tiny() { return 1; }`;
    const symbols = await extract(source);

    expect(symbols[0].source).toBe("function tiny() { return 1; }");
  });

  it("truncates source exceeding MAX_SOURCE_LENGTH (5000 chars)", async () => {
    // Create a function with body > 5000 characters
    const longBody = "x".repeat(5100);
    const source = `function huge() { const s = "${longBody}"; }`;
    const symbols = await extract(source);

    expect(symbols[0].source!.length).toBeLessThanOrEqual(5003); // 5000 + "..."
    expect(symbols[0].source!.endsWith("...")).toBe(true);
  });

  it("sets correct line numbers (1-based) for multi-line declarations", async () => {
    const source = `const x = 1;

function multiLine(
  a: number,
  b: number,
): number {
  return a + b;
}`;
    const symbols = await extract(source);

    const fn = symbols.find((s) => s.name === "multiLine");
    expect(fn).toBeDefined();
    expect(fn!.start_line).toBe(3);
    expect(fn!.end_line).toBe(8);
  });

  it("includes repo in symbol", async () => {
    const source = `interface Foo {}`;
    const parser = await getParser("typescript");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "foo.ts", source, "my-repo");

    expect(symbols[0].repo).toBe("my-repo");
    expect(symbols[0].id).toContain("my-repo:");
  });

  it("includes file path in symbol", async () => {
    const source = `type Bar = string;`;
    const symbols = await extract(source, "src/types/bar.ts");

    expect(symbols[0].file).toBe("src/types/bar.ts");
  });
});

// --- Edge cases and multiple declarations ---

describe("extractTypeScriptSymbols — edge cases", () => {
  it("extracts multiple declarators from a single const statement", async () => {
    const source = `const a = 1, b = "hello", c = true;`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(3);
    expect(symbols.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
    expect(symbols.every((s) => s.kind === "variable")).toBe(true);
  });

  it("handles nested describe > describe > it parent chain", async () => {
    const source = `describe("outer", () => {
  describe("inner", () => {
    it("deep test", () => {});
  });
});`;
    const symbols = await extract(source, "nested.test.ts");

    const outer = symbols.find((s) => s.name === "outer");
    const inner = symbols.find((s) => s.name === "inner");
    const test = symbols.find((s) => s.name === "deep test");

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(test).toBeDefined();
    expect(outer!.kind).toBe("test_suite");
    expect(inner!.kind).toBe("test_suite");
    expect(test!.kind).toBe("test_case");
    expect(inner!.parent).toBe(outer!.id);
    expect(test!.parent).toBe(inner!.id);
  });

  it("returns empty array for source with no extractable symbols", async () => {
    const source = `console.log("hello world");`;
    const symbols = await extract(source);

    // console.log is an expression_statement with a call, but not a test call
    expect(symbols).toEqual([]);
  });

  it("handles mixed declaration types in a single file", async () => {
    const source = `interface Config { port: number; }
type Mode = "dev" | "prod";
const DEFAULT_PORT = 3000;
function start(config: Config) {}
class Server { listen() {} }
enum Env { Dev, Prod }`;
    const symbols = await extract(source);

    const kinds = symbols.map((s) => s.kind).sort();
    expect(kinds).toEqual(["class", "constant", "enum", "function", "interface", "method", "type"]);
  });

  it("does not treat unknown callee as test construct", async () => {
    const source = `myCustomFunction("some label", () => {
  doSomething();
});`;
    const symbols = await extract(source, "custom.test.ts");

    // myCustomFunction is not describe/it/test/beforeEach etc.
    expect(symbols).toEqual([]);
  });

  it("extracts arrow function const with signature", async () => {
    const source = `const transform = (input: string[]): number[] => {
  return input.map(s => s.length);
};`;
    const symbols = await extract(source);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("transform");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].signature).toBe("(input: string[]): : number[]");
  });
});
