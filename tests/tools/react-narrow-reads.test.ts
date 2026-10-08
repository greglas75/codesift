/**
 * The React tools on a REAL index (ADR-004 stage 2).
 *
 * They no longer materialise the index: they read the summary, fetch components/hooks by kind, or
 * page through symbols. A mock cannot show that those reads return the same rows the full array
 * held — so this indexes a fixture into SQLite and asserts real output. `indexFolder` drops the
 * in-memory index when it finishes, so every narrow read here is served by the database, not by a
 * resident copy of the array it replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import { getCodeIndex, indexFolder } from "../../src/tools/index-tools.js";
import { traceComponentTree } from "../../src/tools/react-component-tree-tools.js";
import { analyzeHooks } from "../../src/tools/react-hooks-tools.js";
import { analyzeRenders } from "../../src/tools/react-render-tools.js";
import { reactQuickstart } from "../../src/tools/react-quickstart-tools.js";
import { auditCompilerReadiness } from "../../src/tools/react-compiler-tools.js";
import { analyzeContextGraph, buildContextGraph } from "../../src/tools/react-context-tools.js";
import { REACT_TOOL_ENTRIES } from "../../src/register-tool-groups/react.js";
import type { CallNode } from "../../src/types.js";

const FILES: Record<string, string> = {
  "src/components/Button.tsx": `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`,
  "src/components/Card.tsx": `import { useState } from "react";
import { Button } from "./Button";

export function Card() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button label="x" onClick={() => setOpen(!open)} style={{ margin: 0 }} />
    </div>
  );
}
`,
  "src/App.tsx": `import { createContext, useContext } from "react";
import { Card } from "./components/Card";

export const ThemeContext = createContext("light");

export function useTheme() {
  return useContext(ThemeContext);
}

export function App() {
  const theme = useTheme();
  return (
    <ThemeContext.Provider value={theme}>
      <Card />
    </ThemeContext.Provider>
  );
}
`,
  "src/App.test.tsx": `import { App } from "./App";
export function RendersApp() {
  return <App />;
}
`,
  "src/util.ts": `export const helper = 1;
`,
};

let tmpDir = "";
let repo = "";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-react-narrow-"));
  const projDir = join(tmpDir, "react-narrow-project");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [rel, content] of Object.entries(FILES)) {
    const full = join(projDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  repo = (await indexFolder(projDir, { watch: false })).repo;
}, 60_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function childNames(node: CallNode): string[] {
  return node.children.map((child) => child.symbol.name);
}

describe("React tools read narrowly from a real index", () => {
  it("trace_component_tree walks App → Card → Button", async () => {
    const tree = await traceComponentTree(repo, "App", { depth: 3 }) as CallNode;
    expect(tree.symbol.name).toBe("App");
    expect(childNames(tree)).toEqual(["Card"]);
    expect(childNames(tree.children[0]!)).toEqual(["Button"]);
  });

  it("trace_component_tree keeps its not-found messages", async () => {
    await expect(traceComponentTree(repo, "Nope")).rejects.toThrow(
      `Component "Nope" not found in repository "${repo}"`,
    );
    await expect(traceComponentTree("local/no-such-repo", "App")).rejects.toThrow(
      "Repository not found: local/no-such-repo",
    );
  });

  it("analyze_hooks inventories components and hooks with their source", async () => {
    const result = await analyzeHooks(repo);
    // Button, Card, App — the test file's component is excluded by default.
    expect(result.total_components).toBe(3);
    expect(result.total_custom_hooks).toBe(1);
    expect(result.entries.map((e) => e.name).sort()).toEqual(["App", "Card", "useTheme"]);
    expect(result.hook_usage.map((h) => h.name)).toEqual(expect.arrayContaining(["useState", "useContext", "useTheme"]));
  });

  it("analyze_hooks stops at max_entries and narrows to a named component", async () => {
    const capped = await analyzeHooks(repo, { max_entries: 1 });
    expect(capped.entries).toHaveLength(1);

    const named = await analyzeHooks(repo, { component_name: "Card" });
    expect(named.entries.map((e) => e.name)).toEqual(["Card"]);
    expect(named.entries[0]!.hooks.map((h) => h.name)).toEqual(["useState"]);
  });

  it("analyze_renders finds the inline props in Card", async () => {
    const result = await analyzeRenders(repo);
    if (typeof result === "string") throw new Error("expected JSON");
    expect(result.total_components).toBe(3);
    const card = result.entries.find((e) => e.name === "Card");
    expect(card).toBeDefined();
    expect(card!.risks.map((r) => r.type)).toEqual(expect.arrayContaining(["inline-object", "inline-function"]));
    expect(result.metadata).toBeUndefined();
  });

  it("react_quickstart counts components and hooks and picks App as root", async () => {
    const result = await reactQuickstart(repo);
    expect(result.overview.total_components).toBe(3);
    expect(result.overview.total_custom_hooks).toBe(1);
    expect(result.overview.likely_root_component).toBe("App");
    expect(result.top_hooks.map((h) => h.name)).toEqual(expect.arrayContaining(["useState", "useTheme"]));
  });

  it("audit_compiler_readiness counts the non-test components", async () => {
    const result = await auditCompilerReadiness(repo);
    expect(result.total_components).toBe(3);
    const withTests = await auditCompilerReadiness(repo, { include_tests: true });
    expect(withTests.total_components).toBe(4);
  });

  it("analyze_context_graph streams to the graph the full symbol array gives", async () => {
    const streamed = await analyzeContextGraph(repo);
    expect(streamed).not.toBeNull();
    expect(streamed!.contexts.map((c) => c.name)).toEqual(["ThemeContext"]);
    expect(streamed!.contexts[0]!.providers).toHaveLength(1);
    expect(streamed!.contexts[0]!.consumers.map((c) => c.component)).toEqual(["useTheme"]);

    // Oracle: the old path — materialise, then build. Loaded AFTER the narrow read so the
    // narrow read above was served by the database rather than by this resident copy.
    const full = await getCodeIndex(repo);
    expect(streamed).toEqual(buildContextGraph(full!.symbols));
  });

  it("analyze_context_graph reports an unindexed repo as null", async () => {
    await expect(analyzeContextGraph("local/no-such-repo")).resolves.toBeNull();
  });

  it("the analyze_context_graph handler serialises the graph and keeps its not-found error", async () => {
    const entry = REACT_TOOL_ENTRIES.find((e) => e.definition.name === "analyze_context_graph")!;
    const handler = entry.definition.handler as (args: Record<string, unknown>) => Promise<string>;
    expect(JSON.parse(await handler({ repo }))).toEqual(await analyzeContextGraph(repo));
    await expect(handler({ repo: "local/no-such-repo" })).rejects.toThrow("Repository not found: local/no-such-repo");
  });
});
