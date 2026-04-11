import { describe, it, expect } from "vitest";
import {
  extractJsxComponents,
  buildJsxAdjacency,
  buildComponentTree,
  extractHookCalls,
  findRuleOfHooksViolations,
  findRenderRisks,
  REACT_STDLIB_HOOKS,
} from "../../src/tools/react-tools.js";
import { isFrameworkEntryPoint } from "../../src/utils/framework-detect.js";
import type { CodeSymbol } from "../../src/types.js";

function sym(
  overrides: Partial<CodeSymbol> & Pick<CodeSymbol, "id" | "name" | "file">,
): CodeSymbol {
  return {
    repo: "test",
    kind: "component",
    start_line: 1,
    end_line: 20,
    ...overrides,
  };
}

describe("extractJsxComponents", () => {
  it("extracts PascalCase JSX elements", () => {
    const names = extractJsxComponents(`<Button><UserList data={x}/></Button>`);
    expect(names.has("Button")).toBe(true);
    expect(names.has("UserList")).toBe(true);
  });

  it("skips HTML elements (lowercase)", () => {
    const names = extractJsxComponents(`<div><span>x</span></div>`);
    expect(names.has("div")).toBe(false);
    expect(names.has("span")).toBe(false);
  });

  it("handles self-closing elements", () => {
    const names = extractJsxComponents(`<Input/><Separator />`);
    expect(names.has("Input")).toBe(true);
    expect(names.has("Separator")).toBe(true);
  });

  it("returns empty set for no JSX", () => {
    const names = extractJsxComponents(`const x = 42;`);
    expect(names.size).toBe(0);
  });
});

describe("buildJsxAdjacency", () => {
  it("builds children map from component JSX usage", () => {
    const App = sym({
      id: "test:App.tsx:App:1",
      name: "App",
      file: "App.tsx",
      source: `function App() { return <Header/><UserList/>; }`,
    });
    const Header = sym({
      id: "test:Header.tsx:Header:1",
      name: "Header",
      file: "Header.tsx",
      source: `function Header() { return <div>title</div>; }`,
    });
    const UserList = sym({
      id: "test:UserList.tsx:UserList:1",
      name: "UserList",
      file: "UserList.tsx",
      source: `function UserList() { return <UserCard/>; }`,
    });
    const UserCard = sym({
      id: "test:UserCard.tsx:UserCard:1",
      name: "UserCard",
      file: "UserCard.tsx",
      source: `function UserCard() { return <div/>; }`,
    });

    const adj = buildJsxAdjacency([App, Header, UserList, UserCard]);
    expect(adj.children.get(App.id)?.map((s) => s.name).sort()).toEqual(["Header", "UserList"]);
    expect(adj.children.get(UserList.id)?.map((s) => s.name)).toEqual(["UserCard"]);
    expect(adj.children.get(Header.id)).toBeUndefined(); // no JSX children
  });

  it("ignores non-component symbols", () => {
    const helper = sym({
      id: "test:u.ts:helper:1",
      name: "helper",
      file: "u.ts",
      kind: "function",
      source: `function helper() { return <div/>; }`,
    });
    const adj = buildJsxAdjacency([helper]);
    expect(adj.children.size).toBe(0);
  });

  it("skips self-references", () => {
    const Recursive = sym({
      id: "test:R.tsx:Recursive:1",
      name: "Recursive",
      file: "R.tsx",
      source: `function Recursive() { return <Recursive/>; }`,
    });
    const adj = buildJsxAdjacency([Recursive]);
    expect(adj.children.get(Recursive.id)).toBeUndefined();
  });
});

describe("buildComponentTree", () => {
  it("builds BFS tree of component composition", () => {
    const App = sym({
      id: "test:App.tsx:App:1",
      name: "App",
      file: "App.tsx",
      source: `function App() { return <Layout><Main/></Layout>; }`,
    });
    const Layout = sym({
      id: "test:Layout.tsx:Layout:1",
      name: "Layout",
      file: "Layout.tsx",
      source: `function Layout() { return <div/>; }`,
    });
    const Main = sym({
      id: "test:Main.tsx:Main:1",
      name: "Main",
      file: "Main.tsx",
      source: `function Main() { return <div/>; }`,
    });

    const adj = buildJsxAdjacency([App, Layout, Main]);
    const tree = buildComponentTree(App, adj, 3);

    expect(tree.symbol.name).toBe("App");
    const childNames = tree.children.map((c) => c.symbol.name).sort();
    expect(childNames).toEqual(["Layout", "Main"]);
  });

  it("respects maxDepth", () => {
    const A = sym({ id: "t:A.tsx:A:1", name: "A", file: "A.tsx", source: `<B/>` });
    const B = sym({ id: "t:B.tsx:B:1", name: "B", file: "B.tsx", source: `<C/>` });
    const C = sym({ id: "t:C.tsx:C:1", name: "C", file: "C.tsx", source: `<D/>` });
    const D = sym({ id: "t:D.tsx:D:1", name: "D", file: "D.tsx", source: `<div/>` });

    const adj = buildJsxAdjacency([A, B, C, D]);
    const tree = buildComponentTree(A, adj, 2);

    expect(tree.symbol.name).toBe("A");
    expect(tree.children[0]?.symbol.name).toBe("B");
    expect(tree.children[0]?.children[0]?.symbol.name).toBe("C");
    // At depth 2, C's children should not be expanded
    expect(tree.children[0]?.children[0]?.children).toEqual([]);
  });
});

describe("extractHookCalls", () => {
  it("extracts use* calls with line numbers", () => {
    const source = `function Foo() {
  const [x, setX] = useState(0);
  useEffect(() => {}, []);
  const auth = useAuth();
  return <div/>;
}`;
    const calls = extractHookCalls(source);
    expect(calls.length).toBe(3);
    expect(calls[0]!.name).toBe("useState");
    expect(calls[0]!.is_stdlib).toBe(true);
    expect(calls[1]!.name).toBe("useEffect");
    expect(calls[2]!.name).toBe("useAuth");
    expect(calls[2]!.is_stdlib).toBe(false);
  });

  it("returns empty for no hook calls", () => {
    const calls = extractHookCalls(`function foo() { return 42; }`);
    expect(calls).toEqual([]);
  });

  it("caps at 20 calls", () => {
    const source = Array.from({ length: 30 }, (_, i) => `  useHook${i}();`).join("\n");
    const calls = extractHookCalls(source);
    expect(calls.length).toBe(20);
  });
});

describe("findRuleOfHooksViolations", () => {
  it("detects hook inside if block", () => {
    const source = `function Foo() {
  if (condition) {
    useState(0);
  }
}`;
    const v = findRuleOfHooksViolations(source);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]).toMatch(/useState.*if/);
  });

  it("detects hook after early return", () => {
    const source = `function Foo() {
  if (!user) return null;
  const [x, setX] = useState(0);
  return <div/>;
}`;
    const v = findRuleOfHooksViolations(source);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((s) => /early return/.test(s))).toBe(true);
  });

  it("returns empty for clean component", () => {
    const source = `function Foo() {
  const [x, setX] = useState(0);
  useEffect(() => {}, []);
  return <div>{x}</div>;
}`;
    const v = findRuleOfHooksViolations(source);
    expect(v).toEqual([]);
  });
});

describe("REACT_STDLIB_HOOKS", () => {
  it("contains major React hooks", () => {
    expect(REACT_STDLIB_HOOKS.has("useState")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("useEffect")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("useCallback")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("useMemo")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("useContext")).toBe(true);
  });

  it("contains React 19 hooks", () => {
    expect(REACT_STDLIB_HOOKS.has("useOptimistic")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("useFormState")).toBe(true);
    expect(REACT_STDLIB_HOOKS.has("use")).toBe(true);
  });

  it("does not contain custom hooks", () => {
    expect(REACT_STDLIB_HOOKS.has("useAuth")).toBe(false);
    expect(REACT_STDLIB_HOOKS.has("useDebounce")).toBe(false);
  });
});

describe("isFrameworkEntryPoint — React", () => {
  const reactFrameworks = new Set(["react" as const]);
  const nextFrameworks = new Set(["nextjs" as const, "react" as const]);

  it("marks page.tsx in app/ as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "Page", file: "app/dashboard/page.tsx" }, nextFrameworks)).toBe(true);
  });

  it("marks layout.tsx in app/ as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "Layout", file: "app/layout.tsx" }, nextFrameworks)).toBe(true);
  });

  it("marks loading.tsx as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "Loading", file: "app/loading.tsx" }, nextFrameworks)).toBe(true);
  });

  it("marks error.tsx as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "ErrorBoundary", file: "app/error.tsx" }, nextFrameworks)).toBe(true);
  });

  it("marks not-found.tsx as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "NotFound", file: "app/not-found.tsx" }, nextFrameworks)).toBe(true);
  });

  it("marks components in pages/ as entry point (React/Next)", () => {
    expect(isFrameworkEntryPoint({ name: "Home", file: "pages/index.tsx" }, reactFrameworks)).toBe(true);
  });

  it("marks Remix route files as entry point", () => {
    expect(isFrameworkEntryPoint({ name: "Dashboard", file: "routes/dashboard.tsx" }, reactFrameworks)).toBe(true);
  });

  it("does not mark utility files as entry points", () => {
    expect(isFrameworkEntryPoint({ name: "helper", file: "src/utils/helper.ts" }, reactFrameworks)).toBe(false);
  });

  it("does not mark component files outside routes as entry points", () => {
    expect(isFrameworkEntryPoint({ name: "Button", file: "src/components/Button.tsx" }, reactFrameworks)).toBe(false);
  });
});

describe("findRenderRisks", () => {
  it("detects inline object prop", () => {
    const source = `function Foo() {
  return <Bar style={{ color: "red" }}/>;
}`;
    const risks = findRenderRisks(source);
    expect(risks.some((r) => r.type === "inline-object")).toBe(true);
  });

  it("detects inline array prop", () => {
    const source = `function Foo() {
  return <Bar items={[1, 2, 3]}/>;
}`;
    const risks = findRenderRisks(source);
    expect(risks.some((r) => r.type === "inline-array")).toBe(true);
  });

  it("detects inline function in event handler", () => {
    const source = `function Foo() {
  return <button onClick={() => doThing()}>click</button>;
}`;
    const risks = findRenderRisks(source);
    expect(risks.some((r) => r.type === "inline-function")).toBe(true);
  });

  it("detects unstable default value = []", () => {
    const source = `function Foo({ items = [], config = {} }) {
  return <div>{items.length}</div>;
}`;
    const risks = findRenderRisks(source);
    expect(risks.filter((r) => r.type === "unstable-default").length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for clean component", () => {
    const source = `function Foo({ name }) {
  const handleClick = useCallback(() => {}, []);
  return <div onClick={handleClick}>{name}</div>;
}`;
    const risks = findRenderRisks(source);
    expect(risks).toEqual([]);
  });

  it("includes suggestion text", () => {
    const source = `function Foo() {
  return <Bar data={{ x: 1 }}/>;
}`;
    const risks = findRenderRisks(source);
    expect(risks[0]?.suggestion).toMatch(/useMemo|const/);
  });
});
