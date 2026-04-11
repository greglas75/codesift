import { describe, it, expect, vi, beforeEach } from "vitest";
import { traceComposeTree, analyzeComposeRecomposition } from "../../src/tools/compose-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
const { getCodeIndex } = await import("../../src/tools/index-tools.js");

function makeSym(overrides: Partial<CodeSymbol> & { name: string }): CodeSymbol {
  return {
    id: `test:${overrides.file ?? "ui.kt"}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: overrides.kind ?? "component",
    file: overrides.file ?? "ui.kt",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 20,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: symbols
      .map((s) => s.file)
      .filter((f, i, a) => a.indexOf(f) === i)
      .map((path) => ({ path, language: "kotlin", symbol_count: 0, last_modified: 0 })),
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: 0,
  };
}

// ---------------------------------------------------------------------------
// trace_compose_tree
// ---------------------------------------------------------------------------

describe("traceComposeTree", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds a shallow tree for a composable that calls two others", async () => {
    const index = makeIndex([
      makeSym({
        name: "HomeScreen",
        kind: "component",
        meta: { compose: true },
        source: `@Composable
fun HomeScreen() {
    Header()
    UserList(users)
    Footer()
}`,
      }),
      makeSym({ name: "Header", kind: "component", meta: { compose: true }, source: "@Composable fun Header() {}" }),
      makeSym({ name: "UserList", kind: "component", meta: { compose: true }, source: "@Composable fun UserList(users: List<User>) {}" }),
      makeSym({ name: "Footer", kind: "component", meta: { compose: true }, source: "@Composable fun Footer() {}" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const tree = await traceComposeTree("test", "HomeScreen");
    expect(tree.root.name).toBe("HomeScreen");
    expect(tree.root.children.map((c) => c.name).sort()).toEqual(["Footer", "Header", "UserList"]);
    expect(tree.total_components).toBe(4);
    expect(tree.max_depth).toBe(1);
  });

  it("builds nested tree (depth > 1)", async () => {
    const index = makeIndex([
      makeSym({
        name: "App",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun App() { MainScreen() }`,
      }),
      makeSym({
        name: "MainScreen",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun MainScreen() { UserCard(user) }`,
      }),
      makeSym({
        name: "UserCard",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun UserCard(user: User) { Text(user.name) }`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const tree = await traceComposeTree("test", "App");
    expect(tree.max_depth).toBe(2);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0]!.name).toBe("MainScreen");
    expect(tree.root.children[0]!.children).toHaveLength(1);
    expect(tree.root.children[0]!.children[0]!.name).toBe("UserCard");
  });

  it("counts fan-in (components used from multiple parents)", async () => {
    const index = makeIndex([
      makeSym({
        name: "ScreenA",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun ScreenA() { SharedWidget() }`,
      }),
      makeSym({
        name: "ScreenB",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun ScreenB() { SharedWidget() }`,
      }),
      makeSym({
        name: "SharedWidget",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun SharedWidget() {}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const treeA = await traceComposeTree("test", "ScreenA");
    expect(treeA.root.children.map((c) => c.name)).toContain("SharedWidget");
  });

  it("excludes @Preview composables from the tree by default", async () => {
    const index = makeIndex([
      makeSym({
        name: "HomeScreen",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun HomeScreen() { Header() }`,
      }),
      makeSym({ name: "Header", kind: "component", meta: { compose: true }, source: "@Composable fun Header() {}" }),
      makeSym({ name: "HomeScreenPreview", kind: "component", meta: { compose: true, compose_preview: true }, source: "@Preview @Composable fun HomeScreenPreview() { HomeScreen() }" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const tree = await traceComposeTree("test", "HomeScreen");
    // Preview should not appear in the tree (it's design-time only)
    expect(tree.total_components).toBe(2);
  });

  it("handles cycles gracefully (A calls B, B calls A)", async () => {
    const index = makeIndex([
      makeSym({
        name: "Alpha",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun Alpha() { Beta() }`,
      }),
      makeSym({
        name: "Beta",
        kind: "component",
        meta: { compose: true },
        source: `@Composable fun Beta() { Alpha() }`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const tree = await traceComposeTree("test", "Alpha");
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0]!.name).toBe("Beta");
    // Cycle should be broken — Beta's children should NOT contain Alpha again
    expect(tree.root.children[0]!.children).toHaveLength(0);
  });

  it("throws when root is not a composable", async () => {
    const index = makeIndex([
      makeSym({ name: "plainFun", kind: "function", source: "fun plainFun() {}" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    await expect(traceComposeTree("test", "plainFun")).rejects.toThrow(/not a.*composable/i);
  });
});

// ---------------------------------------------------------------------------
// analyze_compose_recomposition
// ---------------------------------------------------------------------------

describe("analyzeComposeRecomposition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags mutableStateOf without remember", async () => {
    const index = makeIndex([
      makeSym({
        name: "BuggyScreen",
        kind: "component",
        meta: { compose: true },
        source: `@Composable
fun BuggyScreen() {
    val count = mutableStateOf(0)
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeComposeRecomposition("test");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.issue).toContain("mutableStateOf");
    expect(result.issues[0]!.issue).toContain("remember");
    expect(result.issues[0]!.severity).toBe("critical");
  });

  it("does NOT flag mutableStateOf inside remember", async () => {
    const index = makeIndex([
      makeSym({
        name: "GoodScreen",
        kind: "component",
        meta: { compose: true },
        source: `@Composable
fun GoodScreen() {
    val count = remember { mutableStateOf(0) }
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeComposeRecomposition("test");
    expect(result.issues).toHaveLength(0);
  });

  it("flags unstable collection parameter types", async () => {
    const index = makeIndex([
      makeSym({
        name: "UserList",
        kind: "component",
        meta: { compose: true },
        signature: "(users: List<User>, tags: Map<String, Int>): Unit",
        source: `@Composable fun UserList(users: List<User>, tags: Map<String, Int>) {}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeComposeRecomposition("test");
    const listIssue = result.issues.find((i) => i.param === "users");
    const mapIssue = result.issues.find((i) => i.param === "tags");
    expect(listIssue).toBeDefined();
    expect(listIssue!.issue).toContain("List");
    expect(mapIssue).toBeDefined();
    expect(mapIssue!.issue).toContain("Map");
  });

  it("skips @Preview composables", async () => {
    const index = makeIndex([
      makeSym({
        name: "PreviewBad",
        kind: "component",
        meta: { compose: true, compose_preview: true },
        source: `@Preview @Composable
fun PreviewBad() {
    val x = mutableStateOf(0)
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeComposeRecomposition("test");
    expect(result.components_scanned).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it("returns clean result for well-written composables", async () => {
    const index = makeIndex([
      makeSym({
        name: "CleanComponent",
        kind: "component",
        meta: { compose: true },
        signature: "(title: String, count: Int): Unit",
        source: `@Composable
fun CleanComponent(title: String, count: Int) {
    val expanded = remember { mutableStateOf(false) }
    Text(title)
}`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await analyzeComposeRecomposition("test");
    expect(result.issues).toHaveLength(0);
    expect(result.components_scanned).toBe(1);
  });
});
