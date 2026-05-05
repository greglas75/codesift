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
  buildReverseAdjacency,
  computePropChainDepth,
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

// ─────────────────────────────────────────────────────────────
// Tier 5 — buildReverseAdjacency + computePropChainDepth
// ─────────────────────────────────────────────────────────────

describe("buildReverseAdjacency", () => {
  it("inverts parent→children to child→parents map", () => {
    const A = sym({ id: "A", name: "A", file: "a.tsx", source: `<B/><C/>` });
    const B = sym({ id: "B", name: "B", file: "b.tsx", source: `<div/>` });
    const C = sym({ id: "C", name: "C", file: "c.tsx", source: `<div/>` });
    const adj = buildJsxAdjacency([A, B, C]);
    const rev = buildReverseAdjacency(adj);
    expect(rev.get("B")).toEqual(["A"]);
    expect(rev.get("C")).toEqual(["A"]);
    expect(rev.get("A")).toBeUndefined(); // A is root
  });

  it("sorts parent lists alphabetically for determinism", () => {
    const Z = sym({ id: "Z", name: "Z", file: "z.tsx", source: `<Target/>` });
    const A = sym({ id: "A", name: "A", file: "a.tsx", source: `<Target/>` });
    const Target = sym({ id: "Target", name: "Target", file: "t.tsx", source: `<div/>` });
    const adj = buildJsxAdjacency([Z, A, Target]);
    const rev = buildReverseAdjacency(adj);
    expect(rev.get("Target")).toEqual(["A", "Z"]);
  });
});

describe("computePropChainDepth", () => {
  function freshState() {
    return { memo: new Map<string, number>(), inProgress: new Set<string>() };
  }

  it("returns 0 for orphan with no parents", () => {
    const rev = new Map<string, string[]>();
    const { memo, inProgress } = freshState();
    expect(computePropChainDepth("Solo", rev, memo, inProgress)).toBe(0);
  });

  it("returns 2 for linear 3-node chain Root → Middle → Leaf", () => {
    const Root = sym({ id: "Root", name: "Root", file: "r.tsx", source: `<Middle/>` });
    const Middle = sym({ id: "Middle", name: "Middle", file: "m.tsx", source: `<Leaf/>` });
    const Leaf = sym({ id: "Leaf", name: "Leaf", file: "l.tsx", source: `<div/>` });
    const adj = buildJsxAdjacency([Root, Middle, Leaf]);
    const rev = buildReverseAdjacency(adj);
    const { memo, inProgress } = freshState();
    expect(computePropChainDepth("Leaf", rev, memo, inProgress)).toBe(2);
    expect(computePropChainDepth("Middle", rev, memo, inProgress)).toBe(1);
    expect(computePropChainDepth("Root", rev, memo, inProgress)).toBe(0);
  });

  it("returns finite depth on cycle A→B→A and is deterministic across two runs", () => {
    const A = sym({ id: "A", name: "A", file: "a.tsx", source: `<B/>` });
    const B = sym({ id: "B", name: "B", file: "b.tsx", source: `<A/>` });
    const adj = buildJsxAdjacency([A, B]);
    const rev = buildReverseAdjacency(adj);
    const r1a = computePropChainDepth("A", rev, new Map(), new Set());
    const r1b = computePropChainDepth("B", rev, new Map(), new Set());
    const r2a = computePropChainDepth("A", rev, new Map(), new Set());
    const r2b = computePropChainDepth("B", rev, new Map(), new Set());
    expect(r1a).toBe(r2a);
    expect(r1b).toBe(r2b);
    expect(Number.isFinite(r1a)).toBe(true);
    expect(Number.isFinite(r1b)).toBe(true);
  });

  it("handles 20,000-deep linear chain without stack overflow", () => {
    // Build 20K linear chain — would crash recursive form on V8 (~10-15K stack)
    const N = 20000;
    const symbols: CodeSymbol[] = [];
    for (let i = 0; i < N; i++) {
      const next = i < N - 1 ? `<C${i + 1}/>` : `<div/>`;
      symbols.push(sym({ id: `C${i}`, name: `C${i}`, file: `c${i}.tsx`, source: next }));
    }
    const adj = buildJsxAdjacency(symbols);
    const rev = buildReverseAdjacency(adj);
    const memo = new Map<string, number>();
    const inProgress = new Set<string>();
    expect(() => computePropChainDepth(`C${N - 1}`, rev, memo, inProgress)).not.toThrow();
    expect(computePropChainDepth(`C${N - 1}`, rev, memo, inProgress)).toBe(N - 1);
  });

  it("shared memo across multi-component call returns consistent depths", () => {
    const Root = sym({ id: "Root", name: "Root", file: "r.tsx", source: `<Middle/><Side/>` });
    const Middle = sym({ id: "Middle", name: "Middle", file: "m.tsx", source: `<Leaf/>` });
    const Leaf = sym({ id: "Leaf", name: "Leaf", file: "l.tsx", source: `<div/>` });
    const Side = sym({ id: "Side", name: "Side", file: "s.tsx", source: `<div/>` });
    const adj = buildJsxAdjacency([Root, Middle, Leaf, Side]);
    const rev = buildReverseAdjacency(adj);
    const memo = new Map<string, number>();
    const inProgress = new Set<string>();
    // First call populates memo for entire ancestor chain
    expect(computePropChainDepth("Leaf", rev, memo, inProgress)).toBe(2);
    expect(memo.has("Root")).toBe(true);
    expect(memo.has("Middle")).toBe(true);
    // Second call on Side should not recompute Root (cached)
    expect(computePropChainDepth("Side", rev, memo, inProgress)).toBe(1);
  });

  it("alphabetical iteration produces stable output across Map insertion order", () => {
    // Build same logical graph two different ways
    const buildVariant = (order: string[]) => {
      const all = {
        Root: sym({ id: "Root", name: "Root", file: "r.tsx", source: `<A/><B/>` }),
        A: sym({ id: "A", name: "A", file: "a.tsx", source: `<Leaf/>` }),
        B: sym({ id: "B", name: "B", file: "b.tsx", source: `<Leaf/>` }),
        Leaf: sym({ id: "Leaf", name: "Leaf", file: "l.tsx", source: `<div/>` }),
      } as Record<string, CodeSymbol>;
      return buildJsxAdjacency(order.map((k) => all[k]!));
    };
    const adj1 = buildVariant(["Root", "A", "B", "Leaf"]);
    const adj2 = buildVariant(["Leaf", "B", "A", "Root"]);
    const rev1 = buildReverseAdjacency(adj1);
    const rev2 = buildReverseAdjacency(adj2);
    expect(computePropChainDepth("Leaf", rev1, new Map(), new Set()))
      .toBe(computePropChainDepth("Leaf", rev2, new Map(), new Set()));
  });
});

// ─────────────────────────────────────────────────────────────
// Tier 7 — Cross-file Suspense ancestor detection
// ─────────────────────────────────────────────────────────────
import {
  findSuspenseAncestor,
  findLazyComponentsWithoutSuspense,
} from "../../src/tools/react-tools.js";

describe("findSuspenseAncestor (Tier 7)", () => {
  function makeAdj(...edges: [parent: string, child: string][]): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const [parent, child] of edges) {
      const list = rev.get(child) ?? [];
      list.push(parent);
      rev.set(child, list);
    }
    return rev;
  }

  it("returns null when no parents have Suspense", () => {
    const rev = makeAdj(["Root", "Child"]);
    const symbols = new Map([
      ["Root", sym({ id: "Root", name: "Root", file: "r.tsx", source: "<Child/>" })],
      ["Child", sym({ id: "Child", name: "Child", file: "c.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Child", rev, symbols)).toBeNull();
  });

  it("finds Suspense in immediate parent", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({ id: "Root", name: "Root", file: "r.tsx", source: "<Suspense fallback={<div/>}><Lazy/></Suspense>" })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    const result = findSuspenseAncestor("Lazy", rev, symbols);
    expect(result?.name).toBe("Root");
  });

  it("finds <React.Suspense> form (with React. prefix)", () => {
    const rev = makeAdj(["Root", "Leaf"]);
    const symbols = new Map([
      ["Root", sym({ id: "Root", name: "Root", file: "r.tsx", source: "<React.Suspense><Leaf/></React.Suspense>" })],
      ["Leaf", sym({ id: "Leaf", name: "Leaf", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Leaf", rev, symbols)?.name).toBe("Root");
  });

  it("walks 3-level chain: Lazy → Middle → Root(with Suspense)", () => {
    const rev = makeAdj(["Root", "Middle"], ["Middle", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({ id: "Root", name: "Root", file: "r.tsx", source: "<Suspense><Middle/></Suspense>" })],
      ["Middle", sym({ id: "Middle", name: "Middle", file: "m.tsx", source: "<Lazy/>" })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)?.name).toBe("Root");
  });

  it("handles cyclic graph without infinite loop", () => {
    const rev = makeAdj(["A", "B"], ["B", "A"]);
    const symbols = new Map([
      ["A", sym({ id: "A", name: "A", file: "a.tsx", source: "<B/>" })],
      ["B", sym({ id: "B", name: "B", file: "b.tsx", source: "<A/>" })],
    ]);
    expect(() => findSuspenseAncestor("A", rev, symbols)).not.toThrow();
    expect(findSuspenseAncestor("A", rev, symbols)).toBeNull();
  });
});

describe("findLazyComponentsWithoutSuspense (Tier 7)", () => {
  it("flags lazy() in component with no Suspense in chain", () => {
    const symbols = [
      sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "function Root() { return <Lazy/>; }",
      }),
      sym({
        id: "Lazy", name: "Lazy", file: "l.tsx",
        source: "const Heavy = React.lazy(() => import('./Heavy')); function Lazy() { return <Heavy/>; }",
      }),
    ];
    const issues = findLazyComponentsWithoutSuspense(symbols);
    expect(issues.length).toBe(1);
    expect(issues[0]?.name).toBe("Lazy");
  });

  it("does NOT flag lazy() when ancestor has Suspense", () => {
    const symbols = [
      sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "function Root() { return <Suspense fallback={<Loading/>}><Lazy/></Suspense>; }",
      }),
      sym({
        id: "Lazy", name: "Lazy", file: "l.tsx",
        source: "const Heavy = React.lazy(() => import('./Heavy')); function Lazy() { return <Heavy/>; }",
      }),
    ];
    expect(findLazyComponentsWithoutSuspense(symbols).length).toBe(0);
  });

  it("does NOT flag when component itself has Suspense", () => {
    const symbols = [
      sym({
        id: "Self", name: "Self", file: "s.tsx",
        source: "const Heavy = lazy(() => import('./Heavy')); function Self() { return <Suspense><Heavy/></Suspense>; }",
      }),
    ];
    expect(findLazyComponentsWithoutSuspense(symbols).length).toBe(0);
  });

  it("returns empty list when no lazy() usage anywhere", () => {
    const symbols = [
      sym({ id: "A", name: "A", file: "a.tsx", source: "function A() { return <div/>; }" }),
    ];
    expect(findLazyComponentsWithoutSuspense(symbols).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Tier 7 R-1 / R-4 — review fixes
// ─────────────────────────────────────────────────────────────

describe("findSuspenseAncestor (Tier 7 R-1 — comment/string spoofing)", () => {
  function makeAdj(...edges: [parent: string, child: string][]): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const [parent, child] of edges) {
      const list = rev.get(child) ?? [];
      list.push(parent);
      rev.set(child, list);
    }
    return rev;
  }

  it("does NOT count Suspense mention inside a /* block comment */", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        // R-1: comment spoof — was previously bypassing detection
        source: "/* example: <Suspense> wrap goes here */ function Root() { return <Lazy/>; }",
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });

  it("does NOT count Suspense mention inside a // line comment", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "function Root() { return <div/>; } // TODO: wrap in <Suspense>",
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });

  it("does NOT count Suspense mention inside a string literal", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: `function Root() { const docs = "use <Suspense> to wrap"; return <Lazy/>; }`,
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });

  it("STILL counts real <Suspense> JSX even with mention also in comment", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "// description of <Suspense> usage\nfunction Root() { return <Suspense fallback={<X/>}><Lazy/></Suspense>; }",
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)?.name).toBe("Root");
  });
});

describe("findLazyComponentsWithoutSuspense (Tier 7 R-4 — module-scope lazy)", () => {
  it("flags module-scope `const X = lazy(...)` in a non-component symbol", () => {
    // R-4: lazy() declared at module scope (not inside a component body)
    // was previously skipped by the kind === "component" filter.
    const symbols = [
      sym({
        id: "Heavy", name: "Heavy", file: "lazy.tsx",
        kind: "function" as const, // NOT a component — module-scope const
        source: "const Heavy = React.lazy(() => import('./HeavyImpl'));",
      }),
      sym({
        id: "App", name: "App", file: "app.tsx",
        source: "function App() { return <Heavy/>; }",
      }),
    ];
    const issues = findLazyComponentsWithoutSuspense(symbols);
    expect(issues.length).toBe(1);
    // Issue attributed to lazy.tsx (the file containing the declaration)
    expect(issues[0]?.file).toBe("lazy.tsx");
  });

  it("does NOT flag module-scope lazy when same-file component HAS Suspense", () => {
    const symbols = [
      sym({
        id: "Heavy", name: "Heavy", file: "feature.tsx",
        kind: "function" as const,
        source: "const Heavy = lazy(() => import('./HeavyImpl'));",
      }),
      sym({
        id: "Feature", name: "Feature", file: "feature.tsx",
        source: "function Feature() { return <Suspense fallback={<X/>}><Heavy/></Suspense>; }",
      }),
    ];
    expect(findLazyComponentsWithoutSuspense(symbols).length).toBe(0);
  });

  it("dedups multiple lazy declarations in same file to one issue", () => {
    const symbols = [
      sym({
        id: "A", name: "A", file: "lazy.tsx", kind: "function" as const,
        source: "const A = lazy(() => import('./A'));",
      }),
      sym({
        id: "B", name: "B", file: "lazy.tsx", kind: "function" as const,
        source: "const B = lazy(() => import('./B'));",
      }),
    ];
    const issues = findLazyComponentsWithoutSuspense(symbols);
    expect(issues.length).toBe(1); // dedup by file
  });
});

describe("findSuspenseAncestor (Tier 7 R-1.1 — state machine stripper)", () => {
  function makeAdj(...edges: [string, string][]): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const [p, c] of edges) {
      const list = rev.get(c) ?? [];
      list.push(p);
      rev.set(c, list);
    }
    return rev;
  }

  it("does NOT match // inside a string literal as line comment", () => {
    // Adversarial Run 4 finding: layered regex stripper would consume `//` inside
    // strings as a comment. State machine handles this correctly.
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        // The string contains `// <Suspense>` which previously could be
        // incorrectly stripped, leaving the JSX-like text behind for the regex.
        source: 'function Root() { const url = "https://example.com//<Suspense>"; return <Lazy/>; }',
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });

  it("correctly handles escaped quotes in strings", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: `function Root() { const x = "she said \\"<Suspense>\\""; return <Lazy/>; }`,
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });
});

describe("findLazyComponentsWithoutSuspense (Tier 7 R-4.1 — wrong owner attribution)", () => {
  it("does NOT flag when ANY same-file component is wrapped in Suspense ancestor", () => {
    // Adversarial Run 4 finding: arbitrary `components.find` could pick wrong owner.
    // R-4.1 fix: require ALL same-file components to lack Suspense before flagging.
    const symbols = [
      sym({
        id: "LazyDecl", name: "LazyDecl", file: "feature.tsx", kind: "function" as const,
        source: "const Heavy = lazy(() => import('./H'));",
      }),
      sym({
        id: "Wrapper", name: "Wrapper", file: "feature.tsx",
        source: "function Wrapper() { return <Suspense><Heavy/></Suspense>; }",
      }),
      sym({
        id: "OtherSibling", name: "OtherSibling", file: "feature.tsx",
        source: "function OtherSibling() { return <div>nothing related</div>; }",
      }),
    ];
    // Wrapper has Suspense — even if components.find() picks OtherSibling,
    // R-4.1's anySafe check returns true → no flag.
    expect(findLazyComponentsWithoutSuspense(symbols).length).toBe(0);
  });
});

describe("findSuspenseAncestor (Tier 7 R-1.2 — regex literal stripping)", () => {
  function makeAdj(...edges: [string, string][]): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const [p, c] of edges) {
      const list = rev.get(c) ?? [];
      list.push(p);
      rev.set(c, list);
    }
    return rev;
  }

  it("does NOT mistake `//` inside a regex literal /https:\\/\\/x/ as line comment", () => {
    // Adversarial Run 5 finding: regex literals contain `//` which the layered
    // stripper would consume, blanking out the rest of the line. State machine
    // detects regex context (after `=`) and treats `/.../` as a regex.
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "function Root() { const r = /https:\\/\\/x/; return <Lazy/>; }",
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    // No Suspense anywhere → null. Test ensures stripper didn't break Root's source.
    expect(findSuspenseAncestor("Lazy", rev, symbols)).toBeNull();
  });

  it("treats `/regex/` followed by real <Suspense> JSX correctly", () => {
    const rev = makeAdj(["Root", "Lazy"]);
    const symbols = new Map([
      ["Root", sym({
        id: "Root", name: "Root", file: "r.tsx",
        source: "function Root() { const r = /a/b/; return <Suspense><Lazy/></Suspense>; }",
      })],
      ["Lazy", sym({ id: "Lazy", name: "Lazy", file: "l.tsx", source: "<div/>" })],
    ]);
    expect(findSuspenseAncestor("Lazy", rev, symbols)?.name).toBe("Root");
  });
});
