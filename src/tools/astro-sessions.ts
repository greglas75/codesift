/**
 * Astro 5 Sessions API audit. Detects Astro.session.* / context.session.* usage,
 * cross-checks against astro.config experimental.session flag and adapter compat.
 *   SE01 sessions-used-without-config — usage present but experimental.session is off
 *   SE02 unsupported-adapter           — adapter unknown to compat table
 *   SE03 adapter-needs-extra-config    — e.g., cloudflare requires kv binding (heuristic)
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { extractAstroConventions } from "./astro-config.js";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getProperty } from "./astro-helpers.js";

export interface SessionsIssue {
  code: "SE01" | "SE02" | "SE03" | "SE04";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
}

export interface SessionsAuditResult {
  config_found: boolean;
  adapter: string | null;
  sessions_enabled: boolean;
  usage_count: number;
  usage_files: string[];
  adapter_compatibility: Record<string, boolean>;
  issues: SessionsIssue[];
  summary: { usage_total: number; issues_total: number };
}

// Supported adapters (true = sessions work out of the box;
// "extra-config" = needs additional storage binding).
const ADAPTER_COMPAT: Record<string, true | "extra-config"> = {
  "@astrojs/node": true,
  "@astrojs/vercel": true,
  "@astrojs/netlify": true,
  "@astrojs/deno": true,
  "@astrojs/cloudflare": "extra-config",
};

// Match Astro.session.X(...) and `context.session.X(...)` only — avoids
// false positives like req.session, db.session from other libraries.
const SESSION_USAGE_RE = /\b(?:Astro|context)\.session\s*\.\s*(?:get|set|delete|destroy|regenerate)\s*\(/g;

/** AST-based detection — handles nested objects under `experimental`. */
async function detectExperimentalSession(configPath: string | null): Promise<boolean> {
  if (!configPath) return false;
  let src: string;
  try { src = await readFile(configPath, "utf-8"); } catch { return false; }
  await initParser();
  const lang = configPath.endsWith(".ts") ? "typescript" : "javascript";
  const parser = await getParser(lang);
  if (!parser) return false;
  let tree;
  try { tree = parser.parse(src); } catch { return false; }
  try {
    for (const obj of tree.rootNode.descendantsOfType("object")) {
      const expProp = getProperty(obj, "experimental");
      if (!expProp || expProp.type !== "object") continue;
      const sessionProp = getProperty(expProp, "session");
      // Astro 5: session can be `true` (basic) or an object config like
      // `session: { cookie: { sameSite: "strict" } }`. Any non-`false` value enables it.
      if (sessionProp && sessionProp.text !== "false") return true;
    }
    return false;
  } finally { tree.delete(); }
}

async function findConfigFile(root: string): Promise<string | null> {
  for (const name of ["astro.config.mjs", "astro.config.ts", "astro.config.cjs", "astro.config.js"]) {
    const full = join(root, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export async function auditSessionsFromRoot(root: string): Promise<SessionsAuditResult> {
  const configPath = await findConfigFile(root);
  const config_found = configPath !== null;

  const conventions = config_found
    ? await extractAstroConventions([], root).catch(() => null)
    : null;
  const adapter = conventions?.conventions.adapter ?? null;
  const sessions_enabled = await detectExperimentalSession(configPath);

  const files = await walkDirectory(root, {
    maxFiles: 5000,
    relative: true,
    fileFilter: (ext) => ext === ".astro" || ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs",
  });

  const usage_files: string[] = [];
  let usage_count = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    let src: string;
    try { src = await readFile(abs, "utf-8"); } catch { continue; }
    if (!/\bsession\s*\./.test(src)) continue;
    const matches = src.match(SESSION_USAGE_RE);
    if (matches && matches.length > 0) {
      usage_count += matches.length;
      usage_files.push(rel);
    }
  }

  const issues: SessionsIssue[] = [];
  const cfgRel = relative(root, configPath ?? "") || "astro.config.mjs";
  if (usage_count > 0 && !sessions_enabled) issues.push({ code: "SE01", severity: "error", message: "Sessions API used but experimental.session is not enabled in astro.config", file: usage_files[0] ?? cfgRel, line: 1 });
  if (usage_count > 0 && !adapter) issues.push({ code: "SE04", severity: "error", message: "Sessions API used but no SSR adapter configured — Astro requires an adapter for sessions", file: cfgRel, line: 1 });
  if (usage_count > 0 && adapter) {
    const compat = ADAPTER_COMPAT[adapter];
    if (compat === undefined) issues.push({ code: "SE02", severity: "warning", message: `Adapter "${adapter}" is not in the known Sessions API compatibility list`, file: cfgRel, line: 1 });
    else if (compat === "extra-config") issues.push({ code: "SE03", severity: "info", message: `Adapter "${adapter}" supports Sessions but needs extra storage config (e.g. KV binding)`, file: cfgRel, line: 1 });
  }

  const adapter_compatibility: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(ADAPTER_COMPAT)) adapter_compatibility[k] = v === true;
  if (adapter && !(adapter in adapter_compatibility)) adapter_compatibility[adapter] = false;

  return {
    config_found, adapter, sessions_enabled, usage_count, usage_files,
    adapter_compatibility, issues,
    summary: { usage_total: usage_count, issues_total: issues.length },
  };
}

export async function astroSessionsAudit(args: {
  project_root?: string; repo?: string;
}): Promise<SessionsAuditResult> {
  if (args.project_root) return auditSessionsFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { config_found: false, adapter: null, sessions_enabled: false, usage_count: 0, usage_files: [], adapter_compatibility: {}, issues: [], summary: { usage_total: 0, issues_total: 0 } };
  return auditSessionsFromRoot(index.root);
}
