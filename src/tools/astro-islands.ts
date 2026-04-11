/**
 * Astro island analysis + hydration audit (12 AH detectors with A/B/C/D scoring).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { parseAstroTemplate, type Island, type AstroTemplateParse } from "../parser/astro-template.js";
import type { CodeIndex } from "../types.js";

// -- Shared helpers ----------------------------------------------------------

function buildImportMap(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  const fmMatch = source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!fmMatch) return imports;
  const fm = fmMatch[1]!;
  const defaultRe = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = defaultRe.exec(fm)) !== null) imports.set(m[1]!, m[2]!);
  const namedRe = /import\s+(?:\w+\s*,\s*)?\{\s*([^}]+)\}\s*from\s+["']([^"']+)["']/g;
  while ((m = namedRe.exec(fm)) !== null) {
    for (const n of m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()))
      if (n) imports.set(n, m[2]!);
  }
  return imports;
}

function checkServerFallback(source: string, island: Island): boolean {
  const line = source.split("\n")[island.line - 1];
  return !!line && !/\/\s*>/.test(line);
}

function walkAstroFiles(index: CodeIndex, pathPrefix?: string) {
  return index.files.filter((f) => f.language === "astro" && (!pathPrefix || f.path.startsWith(pathPrefix)));
}

// -- 10. astro_analyze_islands -----------------------------------------------

export interface ServerIsland { file: string; line: number; component: string; has_fallback: boolean; }
export interface AnalyzeIslandsResult {
  islands: Island[];
  summary: { total_islands: number; by_directive: Record<string, number>; by_framework: Record<string, number>; warnings: string[] };
  server_islands: ServerIsland[];
}

export async function astroAnalyzeIslands(args: { repo?: string; path_prefix?: string; include_recommendations?: boolean }): Promise<AnalyzeIslandsResult> {
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { islands: [], summary: { total_islands: 0, by_directive: {}, by_framework: {}, warnings: [] }, server_islands: [] };
  return analyzeIslandsFromIndex(index, args.path_prefix);
}

export function analyzeIslandsFromIndex(index: CodeIndex, pathPrefix?: string): AnalyzeIslandsResult {
  const allIslands: Island[] = [], serverIslands: ServerIsland[] = [];
  for (const file of walkAstroFiles(index, pathPrefix)) {
    let source: string;
    try { source = readFileSync(join(index.root, file.path), "utf-8"); } catch { continue; }
    const result = parseAstroTemplate(source, buildImportMap(source));
    for (const island of result.islands) {
      if (island.directive === "server:defer") {
        serverIslands.push({ file: file.path, line: island.line, component: island.component_name, has_fallback: checkServerFallback(source, island) });
      } else {
        allIslands.push({ ...island, file: file.path } as Island);
      }
    }
  }
  const byDirective: Record<string, number> = {}, byFramework: Record<string, number> = {};
  for (const i of allIslands) { byDirective[i.directive] = (byDirective[i.directive] ?? 0) + 1; byFramework[i.framework_hint ?? "unknown"] = (byFramework[i.framework_hint ?? "unknown"] ?? 0) + 1; }
  const warnings: string[] = [];
  const loadCount = allIslands.filter((i) => i.directive === "client:load").length;
  if (loadCount >= 5) warnings.push(`${loadCount} components use client:load — consider client:idle or client:visible for below-fold content`);
  const noFb = serverIslands.filter((s) => !s.has_fallback).length;
  if (noFb > 0) warnings.push(`${noFb} server:defer component(s) lack fallback content`);
  return { islands: allIslands, summary: { total_islands: allIslands.length, by_directive: byDirective, by_framework: byFramework, warnings }, server_islands: serverIslands };
}

// -- 11. astro_hydration_audit -----------------------------------------------

export interface AuditIssue { code: string; severity: "error" | "warning" | "info"; message: string; file: string; line: number; component?: string | undefined; fix: string; fix_snippet?: string | undefined; }
export interface HydrationAuditResult { issues: AuditIssue[]; anti_patterns_checked: string[]; score: "A" | "B" | "C" | "D"; }

const ALL_CODES = ["AH01","AH02","AH03","AH04","AH05","AH06","AH07","AH08","AH09","AH10","AH11","AH12"];
const HEAVY_PKGS = new Set(["react-chartjs-2","chart.js","recharts","mapbox-gl","leaflet","monaco-editor","codemirror","three"]);
const HEAVY_SCOPES = ["@nivo/","@monaco-editor/","@fullcalendar/","@react-three/"];

function isHeavy(p: string) { return HEAVY_PKGS.has(p) || HEAVY_SCOPES.some((s) => p.startsWith(s)); }
function fwFromPath(p: string) { if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "react"; if (p.endsWith(".vue")) return "vue"; if (p.endsWith(".svelte")) return "svelte"; return undefined; }

function issue(code: string, sev: AuditIssue["severity"], msg: string, file: string, line: number, fix: string, comp?: string, snippet?: string): AuditIssue {
  const base: AuditIssue = { code, severity: sev, message: msg, file, line, fix };
  if (comp) base.component = comp;
  if (snippet) base.fix_snippet = snippet;
  return base;
}

/** Generate a concrete fix snippet by replacing the directive in the source line */
function makeSnippet(source: string, lineNum: number, from: string, to: string): string | undefined {
  const line = source.split("\n")[lineNum - 1];
  if (!line) return undefined;
  const fixed = line.replace(from, to);
  return fixed !== line ? fixed.trim() : undefined;
}

function hasStaticPropsOnly(source: string, island: Island): boolean {
  const line = source.split("\n")[island.line - 1];
  if (!line) return false;
  const tm = line.match(new RegExp(`<${island.component_name}\\b([^>]*)>`));
  if (!tm) return false;
  return !/\{/.test(tm[1]!.replace(/client:\w+(?:="[^"]*")?/g, "").replace(/server:\w+/g, ""));
}

function detectIssues(file: string, source: string, parse: AstroTemplateParse, imports: Map<string, string>): AuditIssue[] {
  const out: AuditIssue[] = [];
  const { islands, component_usages } = parse;
  const isClient = (d: string) => d.startsWith("client:");
  for (const il of islands) {
    const { component_name: cn, directive: d, line: ln } = il;
    if (il.target_kind === "astro" && isClient(d))
      out.push(issue("AH01", "error", "client:* on Astro component (server-only)", file, ln, "Remove client:* or convert to framework component", cn));
    if (il.in_loop)
      out.push(issue("AH02", "warning", `${cn} hydrated inside a loop`, file, ln, "Lift hydration above loop or use wrapper component", cn));
    if (d === "client:load" && (il.document_order > 3 || (il.is_inside_section && ["footer","aside","nav"].includes(il.is_inside_section))))
      out.push(issue("AH04", "warning", `${cn} uses client:load below fold`, file, ln, "Use client:visible or client:idle", cn));
    if (d === "client:only" && !il.directive_value)
      out.push(issue("AH05", "error", `${cn} uses client:only without framework`, file, ln, 'Add client:only="react"', cn));
    if (d === "client:load" && hasStaticPropsOnly(source, il))
      out.push(issue("AH07", "info", `${cn} uses client:load with static props only`, file, ln, "Consider client:idle or client:visible", cn));
    const impPath = il.resolves_to_file ?? imports.get(cn);
    if (d === "client:load" && impPath && isHeavy(impPath))
      out.push(issue("AH09", "info", `${cn} eagerly loads heavy package (${impPath})`, file, ln, "Use client:idle or client:visible", cn));
    if (d === "server:defer" && !checkServerFallback(source, il))
      out.push(issue("AH10", "warning", `${cn} uses server:defer without fallback`, file, ln, "Add fallback content inside component tag", cn));
    if (isClient(d) && /^[a-z]/.test(cn))
      out.push(issue("AH12", "warning", `client:* on dynamic/lowercase tag <${cn}>`, file, ln, "Use statically-known component name", cn));
  }
  // AH03: framework import without directive
  const islandNames = new Set(islands.map((i) => i.component_name));
  for (const u of component_usages) {
    if (islandNames.has(u.name) || !u.imported_from) continue;
    const fw = fwFromPath(u.imported_from);
    if (fw) out.push(issue("AH03", "warning", `${u.name} is ${fw} component without client:* directive`, file, u.line, "Add client:load/idle/visible", u.name));
  }
  // AH06: layout wrapped in framework
  if (file.includes("layouts/") || file.includes("layout/")) {
    const first = islands.find((i) => i.document_order === 0 && isClient(i.directive));
    if (first) out.push(issue("AH06", "warning", `Layout wraps content in ${first.component_name}`, file, first.line, "Use HTML wrapper in layouts", first.component_name));
  }
  // AH08: multiple frameworks
  const fws = new Set(islands.map((i) => i.framework_hint).filter(Boolean));
  if (fws.size >= 2) out.push(issue("AH08", "warning", `Multiple frameworks: ${[...fws].join(", ")}`, file, islands[0]!.line, "Separate frameworks into different files"));
  // AH11: transition:persist without persist-props
  const tpRe = /transition:persist(?!-props)/g;
  let tm: RegExpExecArray | null;
  const lines = source.split("\n");
  while ((tm = tpRe.exec(source)) !== null) {
    const ln = source.slice(0, tm.index).split("\n").length;
    if (!/transition:persist-props/.test(lines[ln - 1] ?? ""))
      out.push(issue("AH11", "info", "transition:persist without transition:persist-props", file, ln, "Add transition:persist-props"));
  }
  return out;
}

function computeScore(issues: AuditIssue[]): "A" | "B" | "C" | "D" {
  const e = issues.filter((i) => i.severity === "error").length;
  const w = issues.filter((i) => i.severity === "warning").length;
  if (e >= 3 || w >= 11) return "D"; if (e >= 1 || w >= 6) return "C"; if (w >= 3) return "B"; return "A";
}

export async function astroHydrationAudit(args: { repo?: string; severity?: "all" | "warnings" | "errors"; path_prefix?: string }): Promise<HydrationAuditResult> {
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { issues: [], anti_patterns_checked: ALL_CODES, score: "A" };
  return hydrationAuditFromIndex(index, args.severity, args.path_prefix);
}

export function hydrationAuditFromIndex(index: CodeIndex, severity?: "all" | "warnings" | "errors", pathPrefix?: string): HydrationAuditResult {
  let issues: AuditIssue[] = [];
  for (const file of walkAstroFiles(index, pathPrefix)) {
    let source: string;
    try { source = readFileSync(join(index.root, file.path), "utf-8"); } catch { continue; }
    const imports = buildImportMap(source);
    issues.push(...detectIssues(file.path, source, parseAstroTemplate(source, imports), imports));
  }
  if (severity === "errors") issues = issues.filter((i) => i.severity === "error");
  else if (severity === "warnings") issues = issues.filter((i) => i.severity !== "info");
  return { issues, anti_patterns_checked: ALL_CODES, score: computeScore(issues) };
}
