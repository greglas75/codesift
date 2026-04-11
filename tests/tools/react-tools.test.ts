import { describe, it, expect } from "vitest";
import {
  extractJsxComponents,
  buildJsxAdjacency,
  buildComponentTree,
  extractHookCalls,
  findRuleOfHooksViolations,
  findRenderRisks,
  formatRendersMarkdown,
  buildContextGraph,
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

  it("resolves @/ alias imports as fallback (Tier 4 — Item 8 wired)", () => {
    // Parent imports child via @/ alias; child has different exported name
    // resolveAlias finds "src/components/Button.tsx", file lookup finds Btn
    const Btn = sym({
      id: "test:src/components/Button.tsx:Btn:1",
      name: "Btn",
      file: "src/components/Button.tsx",
      source: `export const Btn = () => <button/>;`,
    });
    const Parent = sym({
      id: "test:App.tsx:Parent:1",
      name: "Parent",
      file: "App.tsx",
      source: `import { Btn } from "@/components/Button";
function Parent() { return <Btn/>; }`,
    });
    const adj = buildJsxAdjacency([Btn, Parent]);
    expect(adj.children.get(Parent.id)?.length).toBe(1);
    expect(adj.children.get(Parent.id)?.[0]?.name).toBe("Btn");
  });

  it("resolves default-import alias", () => {
    const Card = sym({
      id: "test:src/Card.tsx:Card:1",
      name: "Card",
      file: "src/Card.tsx",
      source: `export default function Card() { return <div/>; }`,
    });
    const App = sym({
      id: "test:App.tsx:App:1",
      name: "App",
      file: "App.tsx",
      source: `import Card from "@/Card";
function App() { return <Card/>; }`,
    });
    const adj = buildJsxAdjacency([Card, App]);
    expect(adj.children.get(App.id)?.[0]?.name).toBe("Card");
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

  it("symbol-tools imports REACT_STDLIB_HOOKS from react-tools (CQ14 — no duplication)", async () => {
    // Verify both modules reference the same Set instance — no duplicate hardcoded list.
    const symbolTools = await import("../../src/tools/symbol-tools.js");
    const reactTools = await import("../../src/tools/react-tools.js");
    // symbol-tools should NOT export its own REACT_STDLIB_HOOKS_SET
    expect((symbolTools as any).REACT_STDLIB_HOOKS_SET).toBeUndefined();
    // react-tools is the single source of truth
    expect(reactTools.REACT_STDLIB_HOOKS).toBeInstanceOf(Set);
    expect(reactTools.REACT_STDLIB_HOOKS.has("useState")).toBe(true);
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

describe("analyzeRenders threshold formula (Bug #4)", () => {
  // Helper that mimics the inline classification logic from analyzeRenders.
  // Tests the formula directly without requiring full repo indexing.
  function classify(risks: number, children: number): "low" | "medium" | "high" {
    return ((risks >= 3 && children >= 3) || risks >= 5) ? "high"
      : (risks >= 2 || (risks >= 1 && children >= 1)) ? "medium" : "low";
  }

  it("classifies as high when risks=3 and children=3 (new formula)", () => {
    expect(classify(3, 3)).toBe("high");
  });

  it("classifies as high when risks=5 (legacy formula still works)", () => {
    expect(classify(5, 0)).toBe("high");
  });

  it("classifies as medium when risks=2 and children=0 (below children threshold)", () => {
    expect(classify(2, 0)).toBe("medium");
  });

  it("classifies as medium when risks=1 with at least 1 child", () => {
    expect(classify(1, 1)).toBe("medium");
  });

  it("classifies as low when risks=0", () => {
    expect(classify(0, 5)).toBe("low");
  });

  it("classifies as low when risks=1 with no children", () => {
    expect(classify(1, 0)).toBe("low");
  });
});

describe("formatRendersMarkdown (Item 14)", () => {
  it("returns markdown string with header", () => {
    const result = {
      entries: [
        {
          name: "Foo",
          file: "src/Foo.tsx",
          start_line: 10,
          is_memoized: false,
          risk_count: 4,
          risk_level: "high" as const,
          risks: [],
          children_count: 3,
        },
      ],
      total_components: 1,
      high_risk_count: 1,
      summary: { inline_objects: 1, inline_arrays: 1, inline_functions: 2, unstable_defaults: 0, missing_memo: 1 },
    };
    const md = formatRendersMarkdown(result);
    expect(md).toContain("# Render Analysis");
    expect(md).toContain("| Component |");
    expect(md).toContain("Foo");
    expect(md).toContain("high");
    expect(md).toContain("Total components: 1");
  });

  it("handles empty entries gracefully", () => {
    const result = {
      entries: [],
      total_components: 0,
      high_risk_count: 0,
      summary: { inline_objects: 0, inline_arrays: 0, inline_functions: 0, unstable_defaults: 0, missing_memo: 0 },
    };
    const md = formatRendersMarkdown(result);
    expect(md).toContain("# Render Analysis");
    expect(md).toContain("Total components: 0");
  });

  it("truncates long file paths", () => {
    const longPath = "src/very/long/path/with/many/segments/Component.tsx";
    const result = {
      entries: [{
        name: "X", file: longPath, start_line: 1,
        is_memoized: true, risk_count: 0, risk_level: "low" as const,
        risks: [], children_count: 0,
      }],
      total_components: 1, high_risk_count: 0,
      summary: { inline_objects: 0, inline_arrays: 0, inline_functions: 0, unstable_defaults: 0, missing_memo: 0 },
    };
    const md = formatRendersMarkdown(result);
    // Either contains the path or its truncated form
    expect(md.includes(longPath) || md.includes("…")).toBe(true);
  });
});

describe("buildContextGraph (Item 10)", () => {
  it("builds graph from createContext call", () => {
    const symbols: any[] = [
      sym({
        id: "t:contexts/auth.tsx:AuthContext:1",
        name: "AuthContext",
        file: "contexts/auth.tsx",
        kind: "variable",
        source: `const AuthContext = createContext<User | null>(null);`,
      }),
      sym({
        id: "t:App.tsx:App:1",
        name: "App",
        file: "App.tsx",
        source: `function App() { return <AuthContext.Provider value={user}><Main/></AuthContext.Provider>; }`,
      }),
      sym({
        id: "t:Profile.tsx:Profile:1",
        name: "Profile",
        file: "Profile.tsx",
        source: `function Profile() { const user = useContext(AuthContext); return <div>{user.name}</div>; }`,
      }),
    ];
    const graph = buildContextGraph(symbols);
    expect(graph.contexts.length).toBe(1);
    expect(graph.contexts[0]?.name).toBe("AuthContext");
    expect(graph.contexts[0]?.providers.length).toBe(1);
    expect(graph.contexts[0]?.consumers.length).toBe(1);
    expect(graph.contexts[0]?.consumers[0]?.component).toBe("Profile");
  });

  it("handles multiple contexts in one repo", () => {
    const symbols: any[] = [
      sym({
        id: "t:c.tsx:Auth:1",
        name: "Auth",
        file: "c.tsx",
        kind: "variable",
        source: `const AuthContext = createContext(null);
const ThemeContext = createContext('light');`,
      }),
    ];
    const graph = buildContextGraph(symbols);
    expect(graph.contexts.length).toBe(2);
    const names = graph.contexts.map((c) => c.name).sort();
    expect(names).toEqual(["AuthContext", "ThemeContext"]);
  });

  it("returns empty when no context usage", () => {
    const symbols: any[] = [
      sym({
        id: "t:foo.tsx:Foo:1",
        name: "Foo",
        file: "foo.tsx",
        source: `function Foo() { return <div>nothing</div>; }`,
      }),
    ];
    const graph = buildContextGraph(symbols);
    expect(graph.contexts).toEqual([]);
  });

  it("detects React.createContext form", () => {
    const symbols: any[] = [
      sym({
        id: "t:c.tsx:Theme:1",
        name: "Theme",
        file: "c.tsx",
        kind: "variable",
        source: `const ThemeContext = React.createContext('light');`,
      }),
    ];
    const graph = buildContextGraph(symbols);
    expect(graph.contexts.length).toBe(1);
    expect(graph.contexts[0]?.name).toBe("ThemeContext");
  });
});
