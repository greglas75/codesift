import type { Island, SectionLandmark } from "./types.js";

const SECTION_LANDMARKS = new Set<SectionLandmark>(["header", "footer", "aside", "nav", "main"]);
const FW_HINTS = ["react", "vue", "svelte", "solid", "preact", "lit"] as const;
const EXT_TO_FW: Record<string, Island["framework_hint"]> = {
  ".solid.tsx": "solid", ".solid.jsx": "solid", ".lit.ts": "lit",
  ".tsx": "react", ".jsx": "react", ".vue": "vue", ".svelte": "svelte",
};

export function isSectionLandmark(tag: string): boolean { return SECTION_LANDMARKS.has(tag as SectionLandmark); }
export function asSectionLandmark(tag: string): SectionLandmark { return tag as SectionLandmark; }

export function lineColAt(text: string, offset: number): { line: number; column: number } {
  let line = 1, lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") { line++; lastNl = i; }
  }
  return { line, column: offset - lastNl };
}

export function findExprStart(template: string, offset: number): number {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (template[i] === "}") depth++;
    else if (template[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function inferFramework(path: string): Island["framework_hint"] | undefined {
  for (const [ext, hint] of Object.entries(EXT_TO_FW)) if (path.endsWith(ext)) return hint;
  return undefined;
}

export function resolveImport(name: string, imports?: Map<string, string>): {
  target_kind: Island["target_kind"]; resolves_to_file?: string; framework_hint?: Island["framework_hint"];
} {
  if (!imports) return { target_kind: "unknown" };
  const file = imports.get(name);
  if (!file) return { target_kind: "unknown" };
  if (file.endsWith(".astro")) return { target_kind: "astro", resolves_to_file: file };
  const hint = inferFramework(file);
  return { target_kind: hint ? "framework" : "unknown", resolves_to_file: file, framework_hint: hint };
}

export function hasSlotContent(template: string, afterPos: number, tag: string): boolean {
  const closeIndex = template.indexOf(`</${tag}`, afterPos);
  return closeIndex >= 0 && template.slice(afterPos, closeIndex).trim().length > 0;
}

export function inferClientOnlyFramework(value: string | undefined): Island["framework_hint"] | undefined {
  return value && (FW_HINTS as readonly string[]).includes(value)
    ? value as Island["framework_hint"]
    : undefined;
}
