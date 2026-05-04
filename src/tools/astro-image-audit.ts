/**
 * Astro image audit. Scans .astro pages for raw <img>, <Image>, <Picture>
 * usage and validates alt attributes + getImage()/astro:assets imports.
 *   IM01 raw-img-recommend-Image  — <img> tag (recommend <Image>)
 *   IM02 missing-alt              — img without alt attribute
 *   IM03 empty-alt                — img with alt="" (intentional? warn)
 *   IM04 getImage-missing-import  — getImage() used without astro:assets import
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";

export interface ImageIssue {
  code: "IM01" | "IM02" | "IM03" | "IM04";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
}

export interface ImageAuditResult {
  raw_img_count: number;
  image_component_count: number;
  picture_component_count: number;
  getImage_calls: { file: string; line: number }[];
  missing_alt: { file: string; line: number }[];
  empty_alt: { file: string; line: number }[];
  issues: ImageIssue[];
  summary: { files_scanned: number; issues_total: number };
}

/** Replace <script>, <style>, and HTML comment blocks with same-length whitespace
 *  (newlines preserved) so index→line math stays accurate after stripping. */
function stripNonTemplate(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const IMAGE_COMP_RE = /<Image\b([^>]*?)\/?>/g;
const PICTURE_COMP_RE = /<Picture\b([^>]*?)\/?>/g;
const ALT_RE = /\balt\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})/;
const GET_IMAGE_RE = /\bgetImage\s*\(/g;
const ASSETS_IMPORT_RE = /\bfrom\s+["']astro:assets["']/;

function scanFile(content: string): {
  raw: number; img_comp: number; pic_comp: number;
  getImage_lines: number[]; missing_alt_lines: number[]; empty_alt_lines: number[];
  has_assets_import: boolean;
} {
  // For .astro: split frontmatter (---/---) from template.
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  const frontmatter = fmMatch?.[1] ?? "";
  const template = fmMatch ? fmMatch[2]! : content;

  const cleanedTemplate = stripNonTemplate(template);
  const has_assets_import = ASSETS_IMPORT_RE.test(frontmatter) || ASSETS_IMPORT_RE.test(content);
  // Use length-based offset, NOT indexOf — template could match a substring earlier in the file.
  const offsetBase = fmMatch ? content.length - template.length : 0;

  let raw = 0, img_comp = 0, pic_comp = 0;
  const missing_alt_lines: number[] = [];
  const empty_alt_lines: number[] = [];

  let m: RegExpExecArray | null;
  const imgRe = new RegExp(IMG_TAG_RE.source, "gi");
  while ((m = imgRe.exec(cleanedTemplate))) {
    raw++;
    const attrs = m[1] ?? "";
    const altMatch = attrs.match(ALT_RE);
    const line = lineOf(content, offsetBase + m.index);
    if (!altMatch) missing_alt_lines.push(line);
    else {
      const v = altMatch[1]!;
      const inner = v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v;
      if (inner.trim() === "") empty_alt_lines.push(line);
    }
  }
  const compRe = new RegExp(IMAGE_COMP_RE.source, "g");
  while ((m = compRe.exec(cleanedTemplate))) img_comp++;
  const picRe = new RegExp(PICTURE_COMP_RE.source, "g");
  while ((m = picRe.exec(cleanedTemplate))) pic_comp++;

  const getImage_lines: number[] = [];
  const giRe = new RegExp(GET_IMAGE_RE.source, "g");
  while ((m = giRe.exec(content))) getImage_lines.push(lineOf(content, m.index));

  return { raw, img_comp, pic_comp, getImage_lines, missing_alt_lines, empty_alt_lines, has_assets_import };
}

export async function auditImagesFromRoot(root: string): Promise<ImageAuditResult> {
  const files = await walkDirectory(root, {
    maxFiles: 5000, relative: true,
    fileFilter: (ext) => ext === ".astro",
  });

  let raw_img_count = 0;
  let image_component_count = 0;
  let picture_component_count = 0;
  const getImage_calls: ImageAuditResult["getImage_calls"] = [];
  const missing_alt: ImageAuditResult["missing_alt"] = [];
  const empty_alt: ImageAuditResult["empty_alt"] = [];
  const issues: ImageIssue[] = [];

  for (const rel of files) {
    let src: string;
    try { src = await readFile(join(root, rel), "utf-8"); } catch { continue; }
    const r = scanFile(src);
    raw_img_count += r.raw;
    image_component_count += r.img_comp;
    picture_component_count += r.pic_comp;
    for (const line of r.missing_alt_lines) {
      missing_alt.push({ file: rel, line });
      issues.push({ code: "IM02", severity: "error", message: "img tag without alt attribute (a11y violation)", file: rel, line });
    }
    for (const line of r.empty_alt_lines) {
      empty_alt.push({ file: rel, line });
      issues.push({ code: "IM03", severity: "warning", message: "img with empty alt — only valid for purely decorative images", file: rel, line });
    }
    for (const line of r.getImage_lines) {
      getImage_calls.push({ file: rel, line });
      if (!r.has_assets_import) issues.push({ code: "IM04", severity: "error", message: "getImage() called but astro:assets is not imported", file: rel, line });
    }
    if (r.raw > 0) issues.push({ code: "IM01", severity: "info", message: `${r.raw} raw <img> tag(s) — consider <Image> from astro:assets for optimization`, file: rel, line: r.missing_alt_lines[0] ?? 1 });
  }

  return {
    raw_img_count, image_component_count, picture_component_count,
    getImage_calls, missing_alt, empty_alt, issues,
    summary: { files_scanned: files.length, issues_total: issues.length },
  };
}

export async function astroImageAudit(args: { project_root?: string; repo?: string }): Promise<ImageAuditResult> {
  if (args.project_root) return auditImagesFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { raw_img_count: 0, image_component_count: 0, picture_component_count: 0, getImage_calls: [], missing_alt: [], empty_alt: [], issues: [], summary: { files_scanned: 0, issues_total: 0 } };
  return auditImagesFromRoot(index.root);
}
