/**
 * Shared Astro template parser — extracts islands, slots, component usages,
 * and directives from the HTML template section of `.astro` files.
 * Pure function, no external CodeSift dependencies. Regex-based (v1).
 */

export interface AstroTemplateParse {
  islands: Island[];
  slots: Slot[];
  component_usages: ComponentUsage[];
  directives: Directive[];
  parse_confidence: "high" | "partial" | "degraded";
  scan_errors: string[];
}

export interface Island {
  component_name: string;
  directive: "client:load" | "client:idle" | "client:visible" | "client:media" | "client:only" | "server:defer";
  directive_value?: string;
  line: number;
  column: number;
  conditional: boolean;
  in_loop: boolean;
  uses_spread: boolean;
  resolves_to_file?: string;
  target_kind: "astro" | "framework" | "unknown";
  framework_hint?: "react" | "vue" | "svelte" | "solid" | "preact" | "lit";
  document_order: number;
  parent_tag?: string;
  is_inside_section?: "header" | "footer" | "aside" | "nav" | "main" | null;
}

export interface Slot { name: string; line: number; has_fallback: boolean; }
export interface ComponentUsage { name: string; line: number; imported_from?: string; }
export interface Directive { name: string; value?: string; line: number; target_tag: string; }

const MAX_TEMPLATE_SIZE = 512_000;
const MAX_BRACE_DEPTH = 100;
const SECTION_LANDMARKS = new Set(["header", "footer", "aside", "nav", "main"]);
const FW_HINTS = ["react", "vue", "svelte", "solid", "preact", "lit"] as const;
const EXT_TO_FW: Record<string, Island["framework_hint"]> = {
  ".tsx": "react", ".jsx": "react", ".vue": "vue",
  ".svelte": "svelte", ".solid.tsx": "solid", ".solid.jsx": "solid", ".lit.ts": "lit",
};

function splitFrontmatter(src: string) {
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { template: src, startLine: 1 };
  return { template: src.slice(m[0].length), startLine: m[0].split("\n").length };
}

function lineColAt(text: string, offset: number) {
  let line = 1, lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") { line++; lastNl = i; }
  }
  return { line, column: offset - lastNl };
}

function inferFw(path: string): Island["framework_hint"] | undefined {
  for (const [ext, hint] of Object.entries(EXT_TO_FW)) if (path.endsWith(ext)) return hint;
  return undefined;
}

function resolveImport(name: string, imports?: Map<string, string>) {
  if (!imports) return { target_kind: "unknown" as const };
  const fp = imports.get(name);
  if (!fp) return { target_kind: "unknown" as const };
  if (fp.endsWith(".astro")) return { target_kind: "astro" as const, resolves_to_file: fp };
  const hint = inferFw(fp);
  return { target_kind: (hint ? "framework" : "unknown") as Island["target_kind"], resolves_to_file: fp, framework_hint: hint };
}

function findExprStart(tpl: string, offset: number): number {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (tpl[i] === "}") depth++;
    else if (tpl[i] === "{") { if (depth === 0) return i; depth--; }
  }
  return -1;
}

function hasSlotContent(tpl: string, afterPos: number, tag: string): boolean {
  const ci = tpl.indexOf(`</${tag}`, afterPos);
  return ci >= 0 && tpl.slice(afterPos, ci).trim().length > 0;
}

const EMPTY: AstroTemplateParse = {
  islands: [], slots: [], component_usages: [], directives: [],
  parse_confidence: "high", scan_errors: [],
};

export function parseAstroTemplate(
  source: string,
  frontmatterImports?: Map<string, string>,
): AstroTemplateParse {
  // Step 1: Normalize BOM + CRLF
  source = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  // Step 2: Split frontmatter / template
  const { template: raw, startLine } = splitFrontmatter(source);

  // Step 3: Size guard
  if (raw.length > MAX_TEMPLATE_SIZE) return { ...EMPTY, parse_confidence: "degraded" };
  if (raw.trim().length === 0) return { ...EMPTY };

  // Step 4: Strip comments (preserve offsets with spaces)
  const tpl = raw.replace(/<!--[\s\S]*?-->/g, m => " ".repeat(m.length));

  // Step 5: Pre-scan brace depth
  let td = 0;
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === "{") { td++; if (td > MAX_BRACE_DEPTH) return { ...EMPTY, parse_confidence: "degraded" }; }
    else if (tpl[i] === "}") td--;
  }

  // Step 6-10: Walk tags
  const tagStack: string[] = [];
  const sectionStack: (Island["is_inside_section"])[] = [];
  const islands: Island[] = [];
  const slots: Slot[] = [];
  const comps: ComponentUsage[] = [];
  const dirs: Directive[] = [];
  let order = 0;

  const tagRe = /<\/?([A-Za-z][A-Za-z0-9._-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(tpl)) !== null) {
    const [full, tagName, attrs] = m;
    const selfClose = m[3] === "/" || full.endsWith("/>");
    const closing = full.startsWith("</");
    const offset = m.index;
    const { line: relLine, column } = lineColAt(tpl, offset);
    const line = relLine + startLine - 1;
    const lower = tagName.toLowerCase();

    if (closing) {
      const idx = tagStack.lastIndexOf(lower);
      if (idx >= 0) {
        tagStack.splice(idx, 1);
        if (SECTION_LANDMARKS.has(lower)) {
          const si = sectionStack.lastIndexOf(lower as Island["is_inside_section"]);
          if (si >= 0) sectionStack.splice(si, 1);
        }
      }
      continue;
    }

    const parentTag = tagStack.length > 0 ? tagStack[tagStack.length - 1] : undefined;
    const section = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : null;

    if (!selfClose) {
      tagStack.push(lower);
      if (SECTION_LANDMARKS.has(lower)) sectionStack.push(lower as Island["is_inside_section"]);
    }

    // Expression context for conditional/loop
    const es = findExprStart(tpl, offset);
    const expr = es >= 0 ? tpl.slice(es, offset) : "";
    const cond = /&&/.test(expr) || /\?[\s\S]*?(?:<|$)/.test(expr);
    const loop = /\.(?:map|forEach|flatMap)\s*\(/.test(expr);

    // Slot detection
    if (lower === "slot") {
      const nm = attrs.match(/name\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      slots.push({ name: nm ? (nm[1] ?? nm[2]) : "default", line, has_fallback: !selfClose && hasSlotContent(tpl, tagRe.lastIndex, lower) });
      continue;
    }

    if (!/^[A-Z]/.test(tagName)) continue;

    // Extract hydration/server directives
    const dRe = /(client:(?:load|idle|visible|media|only)|server:defer)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let dm: RegExpExecArray | null;
    let foundDir: Island["directive"] | null = null;
    let dirVal: string | undefined;

    while ((dm = dRe.exec(attrs)) !== null) {
      foundDir = dm[1] as Island["directive"];
      dirVal = dm[2] ?? dm[3];
      dirs.push({ name: foundDir, value: dirVal, line, target_tag: tagName });
    }

    const spread = /\{\s*\.\.\./.test(attrs);
    comps.push({ name: tagName, line, imported_from: frontmatterImports?.get(tagName) });

    if (foundDir) {
      const ri = resolveImport(tagName, frontmatterImports);
      let fwHint = ri.framework_hint;
      if (foundDir === "client:only" && dirVal && (FW_HINTS as readonly string[]).includes(dirVal))
        fwHint = dirVal as Island["framework_hint"];

      islands.push({
        component_name: tagName, directive: foundDir, directive_value: dirVal,
        line, column, conditional: cond, in_loop: loop, uses_spread: spread,
        resolves_to_file: ri.resolves_to_file, target_kind: ri.target_kind,
        framework_hint: fwHint, document_order: order++,
        parent_tag: parentTag, is_inside_section: section,
      });
    }
  }

  return { islands, slots, component_usages: comps, directives: dirs, parse_confidence: "high", scan_errors: [] };
}
