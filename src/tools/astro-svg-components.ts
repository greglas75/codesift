/** Astro SVG audit: detects ?component imports, tracks usage per file, flags
 *  legacy ?component on Astro 5+, and surfaces tags used without imports.
 *  Codes: SV01 unused-import, SV02 legacy-?component, SV03 used-no-import. */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";

export interface SvgImportRecord {
  name: string;
  path: string;
  file: string;
  line: number;
  used: boolean;
}

export interface SvgIssue {
  code: "SV01" | "SV02" | "SV03";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
  import_name?: string;
}

export interface SvgAuditResult {
  imports: SvgImportRecord[];
  used: string[];
  unused: string[];
  astro_version: string | null;
  issues: SvgIssue[];
  summary: { imports_total: number; issues_total: number };
}

const SVG_IMPORT_RE = /\bimport\s+(\w+)\s+from\s+["']([^"']+\.svg)\?component["']/g;

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

async function readAstroVersion(root: string): Promise<string | null> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    const json: any = JSON.parse(raw);
    return json?.dependencies?.astro ?? json?.devDependencies?.astro ?? null;
  } catch { return null; }
}

function majorVersion(spec: string | null): number | null {
  if (!spec) return null;
  const m = spec.match(/(\d+)\./);
  return m ? Number(m[1]) : null;
}

export async function auditSvgFromRoot(root: string): Promise<SvgAuditResult> {
  const astroVersion = await readAstroVersion(root);
  const major = majorVersion(astroVersion);

  const files = await walkDirectory(root, {
    maxFiles: 5000, relative: true,
    fileFilter: (ext) => ext === ".astro" || ext === ".tsx" || ext === ".jsx" || ext === ".ts" || ext === ".js" || ext === ".mjs",
  });

  // File-scoped tracking — each import verified within ITS OWN file only.
  const imports: SvgImportRecord[] = [];
  const fileSources = new Map<string, string>();
  const fileImports = new Map<string, { name: string; path: string; line: number }[]>();
  for (const rel of files) {
    let src: string;
    try { src = await readFile(join(root, rel), "utf-8"); } catch { continue; }
    fileSources.set(rel, src);
    const inFile: { name: string; path: string; line: number }[] = [];
    for (const m of src.matchAll(new RegExp(SVG_IMPORT_RE.source, "g"))) {
      inFile.push({ name: m[1]!, path: m[2]!, line: lineOf(src, m.index ?? 0) });
    }
    if (inFile.length > 0) fileImports.set(rel, inFile);
  }
  for (const [rel, inFile] of fileImports.entries()) {
    const src = fileSources.get(rel)!;
    for (const imp of inFile) {
      const used = new RegExp(`<${imp.name}\\b`).test(src);
      imports.push({ name: imp.name, path: imp.path, file: rel, line: imp.line, used });
    }
  }

  // Public arrays expose bare names; cross-file collision is already prevented
  // by per-file usage check above (records hold file:name pairs internally).
  const used = imports.filter((i) => i.used).map((i) => i.name);
  const unused = imports.filter((i) => !i.used).map((i) => i.name);

  const issues: SvgIssue[] = [];
  for (const imp of imports) {
    if (!imp.used) {
      issues.push({ code: "SV01", severity: "warning", message: `SVG import "${imp.name}" is never used as a component`, file: imp.file, line: imp.line, import_name: imp.name });
    }
    if (major !== null && major >= 5) {
      issues.push({ code: "SV02", severity: "info", message: `Astro 5+ supports native SVG components — drop "?component" from "${imp.path}"`, file: imp.file, line: imp.line, import_name: imp.name });
    }
  }

  // SV03: <PascalTag /> in template without matching frontmatter import.
  for (const [rel, src] of fileSources.entries()) {
    if (!rel.endsWith(".astro")) continue;
    const fm = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fm) continue;
    const [, frontmatter, template] = fm as [string, string, string];
    const localNames = new Set<string>();
    for (const imp of fileImports.get(rel) ?? []) localNames.add(imp.name);
    for (const m of frontmatter.matchAll(/import\s+(\w+)\s+from/g)) localNames.add(m[1]!);
    for (const m of frontmatter.matchAll(/\{([^}]+)\}\s+from/g)) {
      for (const n of m[1]!.split(",")) localNames.add(n.trim().split(/\s+as\s+/)[0]!.trim());
    }
    const offsetBase = src.length - template.length;
    const seen = new Set<string>();
    for (const m of template.matchAll(/<([A-Z]\w*)\b/g)) {
      const tag = m[1]!;
      if (seen.has(tag) || localNames.has(tag)) continue;
      seen.add(tag);
      issues.push({ code: "SV03", severity: "warning", message: `<${tag} /> used without an import`, file: rel, line: lineOf(src, offsetBase + (m.index ?? 0)) });
    }
  }

  return {
    imports, used, unused, astro_version: astroVersion, issues,
    summary: { imports_total: imports.length, issues_total: issues.length },
  };
}

export async function astroSvgComponents(args: { project_root?: string; repo?: string }): Promise<SvgAuditResult> {
  if (args.project_root) return auditSvgFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { imports: [], used: [], unused: [], astro_version: null, issues: [], summary: { imports_total: 0, issues_total: 0 } };
  return auditSvgFromRoot(index.root);
}
