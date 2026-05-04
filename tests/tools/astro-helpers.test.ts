import { describe, it, expect, beforeAll } from "vitest";
import { getParser, initParser } from "../../src/parser/parser-manager.js";
import {
  stripQuotes,
  getProperty,
  isLiteral,
  classifyZodField,
} from "../../src/tools/astro-helpers.js";

beforeAll(async () => {
  await initParser();
});

async function parseExpression(src: string) {
  const parser = await getParser("javascript");
  if (!parser) throw new Error("parser unavailable");
  const tree = parser.parse(`const __x = ${src};`);
  const root = tree.rootNode;
  const lex = root.descendantsOfType("lexical_declaration")[0]!;
  const decl = lex.descendantsOfType("variable_declarator")[0]!;
  return decl.childForFieldName("value")!;
}

describe("astro-helpers / stripQuotes", () => {
  it("strips matched double quotes", async () => {
    expect(stripQuotes('"abc"')).toBe("abc");
  });
  it("strips matched single quotes", async () => {
    expect(stripQuotes("'abc'")).toBe("abc");
  });
  it("strips matched backticks", async () => {
    expect(stripQuotes("`abc`")).toBe("abc");
  });
  it("leaves mismatched quotes alone", async () => {
    expect(stripQuotes("\"abc'")).toBe("\"abc'");
  });
  it("returns short input unchanged", async () => {
    expect(stripQuotes("a")).toBe("a");
    expect(stripQuotes("")).toBe("");
  });
});

describe("astro-helpers / getProperty", () => {
  it("returns the value node for an existing key", async () => {
    const obj = await parseExpression(`{ a: 1, b: "x" }`);
    const valA = getProperty(obj, "a");
    const valB = getProperty(obj, "b");
    expect(valA?.text).toBe("1");
    expect(valB?.text).toBe('"x"');
  });
  it("returns null for a missing key", async () => {
    const obj = await parseExpression(`{ a: 1 }`);
    expect(getProperty(obj, "nope")).toBeNull();
  });
  it("matches quoted string keys", async () => {
    const obj = await parseExpression(`{ "k": 42 }`);
    expect(getProperty(obj, "k")?.text).toBe("42");
  });
});

describe("astro-helpers / isLiteral", () => {
  it("recognizes literal node types", async () => {
    expect(isLiteral(await parseExpression(`"s"`))).toBe(true);
    expect(isLiteral(await parseExpression(`42`))).toBe(true);
    expect(isLiteral(await parseExpression(`true`))).toBe(true);
    expect(isLiteral(await parseExpression(`false`))).toBe(true);
    expect(isLiteral(await parseExpression(`null`))).toBe(true);
    expect(isLiteral(await parseExpression(`undefined`))).toBe(true);
  });
  it("rejects non-literal node types", async () => {
    expect(isLiteral(await parseExpression(`{}`))).toBe(false);
    expect(isLiteral(await parseExpression(`foo()`))).toBe(false);
  });
});

describe("astro-helpers / classifyZodField", () => {
  it("classifies z.string() as required string", async () => {
    const out = classifyZodField(await parseExpression(`z.string()`));
    expect(out).toEqual({ type: "string", required: true });
  });
  it("marks .optional() chains as not required", async () => {
    const out = classifyZodField(await parseExpression(`z.string().optional()`));
    expect(out.type).toBe("string");
    expect(out.required).toBe(false);
  });
  it("classifies z.number().optional() correctly", async () => {
    const out = classifyZodField(await parseExpression(`z.number().optional()`));
    expect(out.type).toBe("number");
    expect(out.required).toBe(false);
  });
  it("classifies reference('authors') with references set", async () => {
    const out = classifyZodField(await parseExpression(`reference("authors")`));
    expect(out.type).toBe("reference");
    expect(out.references).toBe("authors");
    expect(out.required).toBe(true);
  });
  it("marks .nullable() and .nullish() and .default() as not required", async () => {
    expect(classifyZodField(await parseExpression(`z.string().nullable()`)).required).toBe(false);
    expect(classifyZodField(await parseExpression(`z.string().nullish()`)).required).toBe(false);
    expect(classifyZodField(await parseExpression(`z.string().default("x")`)).required).toBe(false);
  });
});
