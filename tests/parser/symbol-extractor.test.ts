import { tokenizeIdentifier, makeSymbolId } from "../../src/parser/symbol-extractor.js";

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
