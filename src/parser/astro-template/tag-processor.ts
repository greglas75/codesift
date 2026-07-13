import type { Island } from "./types.js";
import { findExprStart, hasSlotContent, inferClientOnlyFramework, lineColAt, resolveImport } from "./resolution.js";
import { TemplateState } from "./state.js";

const DIRECTIVE_RE = /(client:(?:load|idle|visible|media|only)|server:defer)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

export function processTag(
  full: string,
  tag: string,
  attrs: string,
  selfClose: boolean,
  offset: number,
  afterPos: number,
  template: string,
  startLine: number,
  imports: Map<string, string> | undefined,
  state: TemplateState,
): void {
  const lower = tag.toLowerCase();
  const line = lineColAt(template, offset).line + startLine - 1;
  if (full.startsWith("</")) {
    state.close(lower);
    return;
  }
  processOpeningTag({ tag: lower, rawTag: tag, attrs, selfClose, offset, afterPos, template, line, imports, state });
}

interface OpeningTagContext {
  tag: string;
  rawTag: string;
  attrs: string;
  selfClose: boolean;
  offset: number;
  afterPos: number;
  template: string;
  line: number;
  imports: Map<string, string> | undefined;
  state: TemplateState;
}

function processOpeningTag(context: OpeningTagContext): void {
  const { tag, rawTag, attrs, selfClose, offset, afterPos, template, line, state } = context;
  const parentContext = state.context();
  state.open(tag, selfClose);
  const expressionStart = findExprStart(template, offset);
  const expression = expressionStart >= 0 ? template.slice(expressionStart, offset) : "";
  const expressionContext = {
    conditional: /&&/.test(expression) || /\?[\s\S]*?(?:<|$)/.test(expression),
    inLoop: /\.(?:map|forEach|flatMap)\s*\(/.test(expression),
  };

  if (tag === "slot") {
    processSlot(attrs, selfClose, afterPos, template, tag, line, state);
    return;
  }
  if (/^[A-Z]/.test(rawTag)) processComponent(context, expressionContext, parentContext);
}

function processSlot(attrs: string, selfClose: boolean, afterPos: number, template: string, tag: string, line: number, state: TemplateState): void {
  const name = attrs.match(/name\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  state.addSlot({ name: name ? (name[1] ?? name[2] ?? "default") : "default", line, has_fallback: !selfClose && hasSlotContent(template, afterPos, tag) });
}

function processComponent(
  context: OpeningTagContext,
  expressionContext: { conditional: boolean; inLoop: boolean },
  parentContext: { parentTag: string | undefined; section: Island["is_inside_section"] },
): void {
  const { rawTag, attrs, offset, template, line, imports, state } = context;
  const directive = readDirective(attrs, line, rawTag, state);
  state.addComponent({ name: rawTag, line, imported_from: imports?.get(rawTag) });
  if (!directive) return;

  const resolved = resolveImport(rawTag, imports);
  const frameworkHint = directive.name === "client:only"
    ? inferClientOnlyFramework(directive.value) ?? resolved.framework_hint
    : resolved.framework_hint;
  state.addIsland({
    component_name: rawTag, directive: directive.name, directive_value: directive.value,
    line, column: lineColAt(template, offset).column,
    conditional: expressionContext.conditional, in_loop: expressionContext.inLoop,
    uses_spread: /\{\s*\.\.\./.test(attrs),
    resolves_to_file: resolved.resolves_to_file, target_kind: resolved.target_kind,
    framework_hint: frameworkHint, parent_tag: parentContext.parentTag, is_inside_section: parentContext.section,
  });
}

function readDirective(
  attrs: string,
  line: number,
  tag: string,
  state: TemplateState,
): { name: Island["directive"]; value?: string } | null {
  let directive: Island["directive"] | null = null;
  let value: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_RE.exec(attrs)) !== null) {
    directive = match[1] as Island["directive"];
    value = match[2] ?? match[3] ?? undefined;
    state.addDirective({ name: directive, value, line, target_tag: tag });
  }
  return directive ? (value === undefined ? { name: directive } : { name: directive, value }) : null;
}
