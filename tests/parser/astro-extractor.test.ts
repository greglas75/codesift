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

  it("extracts the component name as a function symbol", () => {
    const source = `---
const greeting = "hello";
---
<p>{greeting}</p>
`;
    const symbols = extractAstroSymbols(source, FILE, REPO);
    const component = symbols.find((s) => s.name === "Card");
    expect(component).toBeDefined();
    expect(component!.kind).toBe("function");
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
    expect(component!.kind).toBe("function");
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
});
