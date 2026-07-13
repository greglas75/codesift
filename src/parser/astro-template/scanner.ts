import { processTag } from "./tag-processor.js";
import { TemplateState } from "./state.js";

const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9._-]*)([^>]*?)(\/?)>/g;

export function scanTemplate(template: string, startLine: number, imports?: Map<string, string>): AstroTemplateParseLike {
  const state = new TemplateState();
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(template)) !== null) {
    const [full, rawTag, rawAttrs] = match;
    const tag = rawTag ?? "";
    const attrs = rawAttrs ?? "";
    const selfClose = match[3] === "/" || full.endsWith("/>");
    const offset = match.index;
    processTag(full, tag, attrs, selfClose, offset, TAG_RE.lastIndex, template, startLine, imports, state);
  }
  return state.result();
}

export type AstroTemplateParseLike = ReturnType<TemplateState["result"]>;
