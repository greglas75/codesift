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

describe("extractTypeScriptSymbols — React components", () => {
  it("detects function declaration returning JSX as 'component'", async () => {
    const source = `function MyComponent() {
  return <div>hello</div>;
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects arrow function with implicit JSX return as 'component'", async () => {
    const source = `const MyComponent = () => <div>hello</div>;
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects arrow function with block body returning JSX as 'component'", async () => {
    const source = `const MyComponent = () => {
  const x = 1;
  return <div/>;
};
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects React.memo wrapped component as 'component'", async () => {
    const source = `const MyComponent = React.memo(() => <div/>);
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects forwardRef wrapped component as 'component'", async () => {
    const source = `const MyComponent = forwardRef((props, ref) => <div ref={ref}/>);
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects React.lazy wrapped component as 'component'", async () => {
    const source = `const MyComponent = React.lazy(() => import('./Other'));
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("keeps lowercase function returning value as 'function'", async () => {
    const source = `function myHelper() { return 42; }
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "utils.ts", source, "test-repo");

    const fn = symbols.find((s) => s.name === "myHelper");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("keeps PascalCase function without JSX return as 'function'", async () => {
    const source = `function CreateUser() { return { name: "test" }; }
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "factory.ts", source, "test-repo");

    const fn = symbols.find((s) => s.name === "CreateUser");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("detects exported default function component as 'component'", async () => {
    const source = `export default function Page() {
  return <div>page content</div>;
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "page.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "Page");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects component returning JSX fragment as 'component'", async () => {
    const source = `function Layout() {
  return <>
    <header/>
    <main/>
  </>;
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "Layout.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "Layout");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects component returning parenthesized JSX as 'component'", async () => {
    const source = `function Card() {
  return (
    <div className="card">
      <h1>Title</h1>
    </div>
  );
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "Card.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "Card");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects class extending React.Component as 'component'", async () => {
    const source = `class MyComponent extends React.Component {
  render() { return <div/>; }
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "MyComponent.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "MyComponent");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("detects class extending PureComponent as 'component'", async () => {
    const source = `class Button extends PureComponent {
  render() { return <button/>; }
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "Button.tsx", source, "test-repo");

    const comp = symbols.find((s) => s.name === "Button");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("keeps regular class as 'class'", async () => {
    const source = `class UserService {
  getUser() { return null; }
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "UserService.ts", source, "test-repo");

    const cls = symbols.find((s) => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });
});

describe("extractTypeScriptSymbols — React hooks", () => {
  it("detects function declaration with use[A-Z] name as 'hook'", async () => {
    const source = `function useAuth() {
  return { user: null };
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "useAuth.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "useAuth");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("hook");
  });

  it("detects arrow function hook as 'hook'", async () => {
    const source = `const useDebounce = (value: string) => {
  return value;
};
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "useDebounce.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "useDebounce");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("hook");
  });

  it("detects exported hook as 'hook'", async () => {
    const source = `export function useLocalStorage(key: string) {
  return localStorage.getItem(key);
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "useLocalStorage.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "useLocalStorage");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("hook");
  });

  it("classifies shadowed React hook (useState) as 'hook'", async () => {
    const source = `function useState() {
  return [null, () => {}];
}
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "custom.ts", source, "test-repo");

    const hook = symbols.find((s) => s.name === "useState");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("hook");
  });

  it("keeps 'useless' (no capital after use) as 'function'", async () => {
    const source = `function useless() { return null; }
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "utils.ts", source, "test-repo");

    const fn = symbols.find((s) => s.name === "useless");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("classifies Use() with JSX as 'component', not 'hook'", async () => {
    const source = `function Use() { return <div/>; }
`;
    const parser = await getParser("tsx");
    const tree = parser!.parse(source);
    const symbols = extractTypeScriptSymbols(tree, "Use.tsx", source, "test-repo");

    const sym = symbols.find((s) => s.name === "Use");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("component");
  });
});
