import { describe, it, expect } from "vitest";
import { parseAstroTemplate } from "../../src/parser/astro-template.js";

describe("parseAstroTemplate", () => {
  // Test 1: client:load directive
  it("parses client:load → island with directive client:load", () => {
    const source = `---
import Counter from "./Counter.tsx";
---
<Counter client:load />
`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].component_name).toBe("Counter");
    expect(result.islands[0].directive).toBe("client:load");
  });

  // Test 2: client:idle directive
  it("parses client:idle → correct directive", () => {
    const source = `---\n---\n<Widget client:idle />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].directive).toBe("client:idle");
  });

  // Test 3: client:visible directive
  it("parses client:visible → correct directive", () => {
    const source = `---\n---\n<Chart client:visible />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].directive).toBe("client:visible");
  });

  // Test 4: client:media directive
  it("parses client:media → correct directive", () => {
    const source = `---\n---\n<Sidebar client:media="(max-width: 768px)" />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].directive).toBe("client:media");
    expect(result.islands[0].directive_value).toBe("(max-width: 768px)");
  });

  // Test 5: client:only="react" with framework hint
  it('parses client:only="react" → directive_value and framework_hint', () => {
    const source = `---\n---\n<ReactComponent client:only="react" />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].directive).toBe("client:only");
    expect(result.islands[0].directive_value).toBe("react");
    expect(result.islands[0].framework_hint).toBe("react");
  });

  // Test 6: server:defer directive
  it("parses server:defer → correct directive", () => {
    const source = `---\n---\n<HeavyComponent server:defer />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].directive).toBe("server:defer");
  });

  // Test 7: resolves .astro import → target_kind astro
  it("resolves .astro import → target_kind astro", () => {
    const imports = new Map([["Card", "src/components/Card.astro"]]);
    const source = `---\nimport Card from "./Card.astro";\n---\n<Card client:load />`;
    const result = parseAstroTemplate(source, imports);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].target_kind).toBe("astro");
    expect(result.islands[0].resolves_to_file).toBe("src/components/Card.astro");
  });

  // Test 8: resolves .tsx import → target_kind framework with framework_hint
  it("resolves .tsx import → target_kind framework with framework_hint", () => {
    const imports = new Map([["Counter", "src/components/Counter.tsx"]]);
    const source = `---\nimport Counter from "./Counter.tsx";\n---\n<Counter client:load />`;
    const result = parseAstroTemplate(source, imports);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].target_kind).toBe("framework");
    expect(result.islands[0].framework_hint).toBe("react");
  });

  // Test 9: default slot
  it("parses default slot <slot /> → name default, has_fallback false", () => {
    const source = `---\n---\n<div><slot /></div>`;
    const result = parseAstroTemplate(source);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].name).toBe("default");
    expect(result.slots[0].has_fallback).toBe(false);
  });

  // Test 10: named slot
  it('parses named slot <slot name="sidebar"/> → correct name', () => {
    const source = `---\n---\n<div><slot name="sidebar" /></div>`;
    const result = parseAstroTemplate(source);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].name).toBe("sidebar");
  });

  // Test 11: slot with fallback
  it("parses slot with fallback <slot>fallback</slot> → has_fallback true", () => {
    const source = `---\n---\n<div><slot>Default content</slot></div>`;
    const result = parseAstroTemplate(source);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].has_fallback).toBe(true);
  });

  // Test 12: HTML comment not extracted as island
  it("ignores islands inside HTML comments", () => {
    const source = `---\n---\n<!-- <Counter client:load /> -->\n<div>Hello</div>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(0);
  });

  // Test 13: CRLF normalization
  it("CRLF source parses identically to LF source", () => {
    const lfSource = `---\n---\n<Counter client:load />`;
    const crlfSource = `---\r\n---\r\n<Counter client:load />`;
    const lfResult = parseAstroTemplate(lfSource);
    const crlfResult = parseAstroTemplate(crlfSource);
    expect(crlfResult.islands).toHaveLength(lfResult.islands.length);
    expect(crlfResult.islands[0].directive).toBe(lfResult.islands[0].directive);
    expect(crlfResult.islands[0].component_name).toBe(lfResult.islands[0].component_name);
  });

  // Test 14: BOM prefix stripped
  it("BOM prefix is stripped correctly", () => {
    const source = `\uFEFF---\n---\n<Counter client:load />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].component_name).toBe("Counter");
  });

  // Test 15: in_loop detection
  it("detects in_loop when inside .map()", () => {
    const source = `---\n---\n<div>{items.map(i => <Card client:load />)}</div>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].in_loop).toBe(true);
  });

  // Test 16: conditional detection with &&
  it("detects conditional with && operator", () => {
    const source = `---\n---\n<div>{show && <Card client:load />}</div>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].conditional).toBe(true);
  });

  // Test 17: ternary conditional
  it("detects conditional with ternary for both branches", () => {
    const source = `---\n---\n<div>{cond ? <A client:idle /> : <B client:visible />}</div>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(2);
    expect(result.islands[0].conditional).toBe(true);
    expect(result.islands[1].conditional).toBe(true);
  });

  // Test 18: spread props
  it("detects uses_spread with {...props}", () => {
    const source = `---\n---\n<Widget {...props} client:load />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].uses_spread).toBe(true);
  });

  // Test 19: template >512KB → degraded
  it("returns degraded for template >512KB", () => {
    const bigTemplate = "x".repeat(512001);
    const source = `---\n---\n${bigTemplate}`;
    const result = parseAstroTemplate(source);
    expect(result.parse_confidence).toBe("degraded");
    expect(result.islands).toHaveLength(0);
  });

  // Test 20: brace depth >100 → degraded
  it("returns degraded when brace depth exceeds 100", () => {
    const nested = "{".repeat(101) + "<X client:load />" + "}".repeat(101);
    const source = `---\n---\n${nested}`;
    const result = parseAstroTemplate(source);
    expect(result.parse_confidence).toBe("degraded");
  });

  // Test 21: document_order increments
  it("assigns incremental document_order to islands", () => {
    const source = `---\n---\n<A client:load />\n<B client:idle />\n<C client:visible />`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(3);
    expect(result.islands[0].document_order).toBe(0);
    expect(result.islands[1].document_order).toBe(1);
    expect(result.islands[2].document_order).toBe(2);
  });

  // Test 22: parent_tag captures enclosing tag
  it("captures parent_tag for enclosing element", () => {
    const source = `---\n---\n<footer><Widget client:load /></footer>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].parent_tag).toBe("footer");
  });

  // Test 23: is_inside_section returns landmark section
  it("returns is_inside_section for landmark elements", () => {
    const source = `---\n---\n<footer><div><Widget client:load /></div></footer>`;
    const result = parseAstroTemplate(source);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0].is_inside_section).toBe("footer");
  });

  // Test 24: component usage matched against frontmatterImports
  it("matches component in template against frontmatterImports", () => {
    const imports = new Map([["Footer", "src/components/Footer.astro"]]);
    const source = `---\nimport Footer from "./Footer.astro";\n---\n<Footer />`;
    const result = parseAstroTemplate(source, imports);
    expect(result.component_usages).toHaveLength(1);
    expect(result.component_usages[0].name).toBe("Footer");
    expect(result.component_usages[0].imported_from).toBe("src/components/Footer.astro");
  });

  // Test 25: empty template
  it("returns high confidence with empty arrays for empty template", () => {
    const source = `---\nconst x = 1;\n---\n`;
    const result = parseAstroTemplate(source);
    expect(result.parse_confidence).toBe("high");
    expect(result.islands).toHaveLength(0);
    expect(result.slots).toHaveLength(0);
    expect(result.component_usages).toHaveLength(0);
    expect(result.directives).toHaveLength(0);
  });
});
