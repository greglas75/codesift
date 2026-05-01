import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractJavaScriptSymbols } from "../../src/parser/extractors/javascript.js";

beforeAll(async () => {
  await initParser();
});

async function parse(source: string, file = "sample.js") {
  const parser = await getParser("javascript");
  const tree = parser!.parse(source);
  return extractJavaScriptSymbols(tree, file, source, "test-repo");
}

describe("JavaScript class fields (field_definition)", () => {
  it("extracts public class fields", async () => {
    const source = `class Counter {
  count = 0;
  label = "items";
  inc() { this.count++; }
}
`;
    const symbols = await parse(source);
    const fields = symbols.filter((s) => s.kind === "field");
    expect(fields.map((f) => f.name).sort()).toEqual(["count", "label"]);
    // Both fields should be parented to the Counter class
    const counter = symbols.find((s) => s.name === "Counter");
    expect(counter).toBeDefined();
    expect(fields.every((f) => f.parent === counter!.id)).toBe(true);
  });

  it("extracts private class fields (#name)", async () => {
    const source = `class Vault {
  #secret = "x";
  reveal() { return this.#secret; }
}
`;
    const symbols = await parse(source);
    const priv = symbols.find((s) => s.kind === "field");
    expect(priv).toBeDefined();
    expect(priv!.name).toBe("#secret");
  });

  it("extracts static class fields", async () => {
    const source = `class Cfg {
  static VERSION = "1.0";
}
`;
    const symbols = await parse(source);
    const ver = symbols.find((s) => s.name === "VERSION");
    expect(ver).toBeDefined();
    expect(ver!.kind).toBe("field");
  });
});

describe("JavaScript class_static_block", () => {
  it("emits a <static> method symbol for static initialization blocks", async () => {
    const source = `class Registry {
  static {
    Registry.cache = new Map();
  }
}
`;
    const symbols = await parse(source);
    const stat = symbols.find((s) => s.name === "<static>");
    expect(stat).toBeDefined();
    expect(stat!.kind).toBe("method");
    const cls = symbols.find((s) => s.name === "Registry");
    expect(stat!.parent).toBe(cls!.id);
  });
});

describe("JavaScript generator functions", () => {
  it("flags generator_function_declaration with meta.generator", async () => {
    const source = `function* counter() {
  yield 1;
  yield 2;
}
`;
    const symbols = await parse(source);
    const fn = symbols.find((s) => s.name === "counter");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect((fn!.meta as { generator?: boolean } | undefined)?.generator).toBe(true);
  });
});

describe("CommonJS exports — module.exports.X", () => {
  it("emits exported function for module.exports.foo = function", async () => {
    const source = `module.exports.handler = function (req, res) { return res.end(); };
`;
    const symbols = await parse(source);
    const handler = symbols.find((s) => s.name === "handler");
    expect(handler).toBeDefined();
    expect(handler!.kind).toBe("function");
    expect(handler!.is_exported).toBe(true);
  });

  it("emits exported function for exports.foo = arrow", async () => {
    const source = `exports.handler = (req, res) => res.end();
`;
    const symbols = await parse(source);
    const handler = symbols.find((s) => s.name === "handler");
    expect(handler).toBeDefined();
    expect(handler!.kind).toBe("function");
    expect(handler!.is_exported).toBe(true);
  });

  it("emits constant kind for SCREAMING_CASE exports.X = literal", async () => {
    const source = `exports.MAX_RETRIES = 3;
`;
    const symbols = await parse(source);
    const c = symbols.find((s) => s.name === "MAX_RETRIES");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("constant");
    expect(c!.is_exported).toBe(true);
  });
});

describe("CommonJS exports — module.exports = ...", () => {
  it("tags prior-declared identifier when module.exports = X", async () => {
    const source = `function greet(name) { return "hi " + name; }
module.exports = greet;
`;
    const symbols = await parse(source);
    const greet = symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.is_exported).toBe(true);
  });

  it("tags shorthand object members", async () => {
    const source = `function foo() {}
function bar() {}
module.exports = { foo, bar };
`;
    const symbols = await parse(source);
    const foo = symbols.find((s) => s.name === "foo");
    const bar = symbols.find((s) => s.name === "bar");
    expect(foo!.is_exported).toBe(true);
    expect(bar!.is_exported).toBe(true);
  });

  it("emits inline arrow members from module.exports = { handler: () => {} }", async () => {
    const source = `module.exports = {
  handler: (req) => req.body,
};
`;
    const symbols = await parse(source);
    const h = symbols.find((s) => s.name === "handler");
    expect(h).toBeDefined();
    expect(h!.kind).toBe("function");
    expect(h!.is_exported).toBe(true);
  });

  it("emits a default symbol for module.exports = arrow", async () => {
    const source = `module.exports = function (x) { return x + 1; };
`;
    const symbols = await parse(source);
    const def = symbols.find((s) => s.kind === "default_export");
    expect(def).toBeDefined();
    expect(def!.is_exported).toBe(true);
  });
});

describe("Object-literal methods", () => {
  it("extracts method shorthand from object literals", async () => {
    const source = `const ctrl = {
  create(req) { return req.body; },
  update(req) { return req.body; },
};
`;
    const symbols = await parse(source);
    const create = symbols.find((s) => s.name === "create");
    const update = symbols.find((s) => s.name === "update");
    expect(create).toBeDefined();
    expect(create!.kind).toBe("method");
    expect(update).toBeDefined();
    expect(update!.kind).toBe("method");
    const ctrl = symbols.find((s) => s.name === "ctrl");
    expect(create!.parent).toBe(ctrl!.id);
  });

  it("extracts arrow assigned in pair as method", async () => {
    const source = `const handlers = {
  onClick: () => {},
};
`;
    const symbols = await parse(source);
    const onClick = symbols.find((s) => s.name === "onClick");
    expect(onClick).toBeDefined();
    expect(onClick!.kind).toBe("method");
  });

  it("preserves hook classification inside an object literal", async () => {
    const source = `const useStuff = () => 1;
const lib = {
  useThing: () => 2,
};
`;
    const symbols = await parse(source);
    const useThing = symbols.find((s) => s.name === "useThing");
    expect(useThing).toBeDefined();
    expect(useThing!.kind).toBe("hook");
  });
});

describe("JSX in .jsx files", () => {
  it("classifies PascalCase JSX function as component", async () => {
    const source = `function Button(props) {
  return <button>{props.label}</button>;
}
`;
    const symbols = await parse(source, "Button.jsx");
    const btn = symbols.find((s) => s.name === "Button");
    expect(btn).toBeDefined();
    expect(btn!.kind).toBe("component");
  });

  it("classifies useX arrow as hook", async () => {
    const source = `const useToggle = () => {
  return [true, () => {}];
};
`;
    const symbols = await parse(source, "useToggle.js");
    const hook = symbols.find((s) => s.name === "useToggle");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("hook");
  });
});

describe("Regression — TS-only nodes never appear in JS", () => {
  it("does not crash on JS class without TS-specific modifiers", async () => {
    const source = `class Foo {
  constructor() { this.x = 1; }
  get y() { return this.x; }
  static factory() { return new Foo(); }
}
`;
    const symbols = await parse(source);
    expect(symbols.find((s) => s.name === "Foo")).toBeDefined();
    expect(symbols.find((s) => s.name === "factory")).toBeDefined();
  });
});
