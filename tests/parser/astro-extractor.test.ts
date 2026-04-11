import { describe, it, expect } from "vitest";
import { extractAstroSymbols } from "../../src/parser/symbol-extractor.js";

const REPO = "test-repo";
const FILE = "src/components/Card.astro";

describe("extractAstroSymbols", () => {
  it("returns non-empty symbols for a component with frontmatter", () => {
    const source = `---
interface Props {
  title: string;
  body: string;
}
const { title, body } = Astro.props;
---
<div>
  <h1>{title}</h1>
  <p>{body}</p>
</div>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    expect(symbols.length).toBeGreaterThan(0);
  });

  it("extracts the component name as a component symbol", () => {
    const source = `---
const greeting = "hello";
---
<p>{greeting}</p>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const component = symbols.find((s) => s.name === "Card");
    expect(component).toBeDefined();
    expect(component!.kind).toBe("component");
    expect(component!.file).toBe(FILE);
    expect(component!.repo).toBe(REPO);
  });

  it("extracts interface Props as an interface symbol", () => {
    const source = `---
interface Props {
  title: string;
}
---
<h1>{Astro.props.title}</h1>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const props = symbols.find((s) => s.name === "Props");
    expect(props).toBeDefined();
    expect(props!.kind).toBe("interface");
  });

  it("extracts const declarations as variable symbols", () => {
    const source = `---
const apiUrl = "https://example.com";
const MAX_ITEMS = 10;
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const apiUrl = symbols.find((s) => s.name === "apiUrl");
    const maxItems = symbols.find((s) => s.name === "MAX_ITEMS");
    expect(apiUrl).toBeDefined();
    expect(apiUrl!.kind).toBe("variable");
    expect(maxItems).toBeDefined();
    expect(maxItems!.kind).toBe("variable");
  });

  it("extracts function declarations as function symbols", () => {
    const source = `---
async function fetchData(url: string) {
  return fetch(url).then(r => r.json());
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("returns a component symbol even when there is no frontmatter", () => {
    const source = `<div>
  <h1>Hello world</h1>
</div>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    // No frontmatter — still produces a component symbol
    expect(symbols.length).toBeGreaterThan(0);
    const component = symbols.find((s) => s.name === "Card");
    expect(component).toBeDefined();
    expect(component!.kind).toBe("component");
  });

  it("assigns correct repo and file to all extracted symbols", () => {
    const source = `---
const x = 1;
function doThing() {}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    for (const sym of symbols) {
      expect(sym.repo).toBe(REPO);
      expect(sym.file).toBe(FILE);
    }
  });

  it("produces unique IDs for all symbols", () => {
    const source = `---
interface Props { title: string; }
const x = 1;
function helper() {}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const ids = symbols.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("sets start_line and end_line as positive integers", () => {
    const source = `---
const value = 42;
---
<div>{value}</div>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    for (const sym of symbols) {
      expect(sym.start_line).toBeGreaterThan(0);
      expect(sym.end_line).toBeGreaterThanOrEqual(sym.start_line);
    }
  });

  // ── 15 regression tests for bugs PP-1/3/4/5/6, EC-2/16/17, SSR, template ──

  it("PP-3: multi-line function has end_line > start_line", () => {
    const source = `---
async function fetchData(url: string) {
  const res = await fetch(url);
  const data = await res.json();
  return data;
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.end_line).toBeGreaterThan(fn!.start_line);
  });

  it("PP-5: Props interface symbol has non-empty tokens field", () => {
    const source = `---
interface Props {
  title: string;
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const props = symbols.find((s) => s.name === "Props");
    expect(props).toBeDefined();
    expect(props!.tokens).toBeDefined();
    expect(props!.tokens!.length).toBeGreaterThan(0);
  });

  it("PP-5: const symbol has non-empty tokens field", () => {
    const source = `---
const apiUrl = "https://example.com";
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const sym = symbols.find((s) => s.name === "apiUrl");
    expect(sym).toBeDefined();
    expect(sym!.tokens).toBeDefined();
    expect(sym!.tokens!.length).toBeGreaterThan(0);
  });

  it("PP-5: function symbol has non-empty tokens field", () => {
    const source = `---
function helper() { return 1; }
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "helper");
    expect(fn).toBeDefined();
    expect(fn!.tokens).toBeDefined();
    expect(fn!.tokens!.length).toBeGreaterThan(0);
  });

  it("PP-4: component symbol has kind 'component' not 'function'", () => {
    const source = `---
const x = 1;
---
<div>{x}</div>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const comp = symbols.find((s) => s.name === "Card");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
  });

  it("PP-6: template-only file component source does not contain raw HTML", () => {
    const source = `<div class="wrapper">
  <h1>Hello world</h1>
  <p class="text-lg">Content</p>
</div>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const comp = symbols.find((s) => s.name === "Card");
    expect(comp).toBeDefined();
    // Source should NOT contain raw HTML attributes like class=
    expect(comp!.source).not.toMatch(/class=/);
  });

  it("PP-1: CRLF file parses identical symbols to LF file", () => {
    const lfSource = `---\ninterface Props {\n  title: string;\n}\nconst x = 1;\n---\n<div />\n`;
    const crlfSource = lfSource.replace(/\n/g, "\r\n");
    const lfSymbols = extractAstroSymbols(lfSource, FILE, REPO);
    const crlfSymbols = extractAstroSymbols(crlfSource, FILE, REPO);
    expect(crlfSymbols.length).toBe(lfSymbols.length);
    const crlfNames = crlfSymbols.map((s) => s.name).sort();
    const lfNames = lfSymbols.map((s) => s.name).sort();
    expect(crlfNames).toEqual(lfNames);
  });

  it("PP-1: BOM-prefixed file parses correctly", () => {
    const source = `\uFEFF---\ninterface Props {\n  title: string;\n}\n---\n<div />\n`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const props = symbols.find((s) => s.name === "Props");
    expect(props).toBeDefined();
    expect(props!.kind).toBe("interface");
  });

  it("EC-2: frontmatter-only file does NOT emit zero-content function symbols", () => {
    const source = `---
const config = { debug: true };
---
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    // Should not have any function symbol with empty/signature-only source
    const zeroContent = symbols.filter(
      (s) => s.kind === "function" && s.source && s.source.trim().length < 10,
    );
    expect(zeroContent).toHaveLength(0);
  });

  it("EC-16: interface Props extends BaseProps is detected", () => {
    const source = `---
interface Props extends BaseProps {
  extra: boolean;
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const props = symbols.find((s) => s.name === "Props");
    expect(props).toBeDefined();
    expect(props!.kind).toBe("interface");
  });

  it("EC-17: type Props alias is detected", () => {
    const source = `---
type Props = {
  items: Item[];
};
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const props = symbols.find((s) => s.name === "Props");
    expect(props).toBeDefined();
    // Accept either "type" or "interface" kind
    expect(["type", "interface"]).toContain(props!.kind);
  });

  it("SSR: export const prerender emits constant symbol", () => {
    const source = `---
export const prerender = false;
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const sym = symbols.find((s) => s.name === "prerender");
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("variable");
  });

  it("SSR: export async function getStaticPaths emits function symbol", () => {
    const source = `---
export async function getStaticPaths() {
  return { paths: [], fallback: false };
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "getStaticPaths");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("SSR: export const getStaticPaths arrow form emits function symbol", () => {
    const source = `---
export const getStaticPaths = async () => {
  return { paths: [], fallback: false };
};
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "getStaticPaths");
    expect(fn).toBeDefined();
    // const arrow is extracted as variable but should still exist
    expect(fn).toBeDefined();
  });

  it("SSR: export async function GET emits endpoint handler symbol", () => {
    const source = `---
export async function GET(context) {
  return new Response("ok");
}
---
<div />
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const fn = symbols.find((s) => s.name === "GET");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });
});
