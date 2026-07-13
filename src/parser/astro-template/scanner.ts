import { processTag } from "./tag-processor.js";
import { TemplateState } from "./state.js";

export function scanTemplate(template: string, startLine: number, imports?: Map<string, string>): AstroTemplateParseLike {
  const state = new TemplateState();
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("<", cursor);
    if (start < 0) break;
    if (!/[\/?A-Za-z!?]/.test(template[start + 1] ?? "")) {
      cursor = start + 1;
      continue;
    }
    const end = findTagEnd(template, start);
    if (end < 0) break;
    const full = template.slice(start, end + 1);
    const match = full.match(/^<\/?([A-Za-z][A-Za-z0-9._-]*)([\s\S]*?)(\/?)>$/);
    if (match) {
      const tag = match[1] ?? "";
      const attrs = match[2] ?? "";
      processTag(full, tag, attrs, match[3] === "/" || full.endsWith("/"), start, end + 1, template, startLine, imports, state);
    }
    cursor = end + 1;
  }
  return state.result();
}

function findTagEnd(template: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  let braceDepth = 0;
  for (let i = start + 1; i < template.length; i++) {
    const char = template[i];
    if (quote) {
      if (char === quote && template[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") { braceDepth++; continue; }
    if (char === "}" && braceDepth > 0) { braceDepth--; continue; }
    if (char === ">" && braceDepth === 0) return i;
  }
  return -1;
}

export type AstroTemplateParseLike = ReturnType<TemplateState["result"]>;
