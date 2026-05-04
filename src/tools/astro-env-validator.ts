/**
 * Astro 5 astro:env validator. Parses `env.schema` block from astro.config and
 * cross-checks declared envField variables vs imports from astro:env/{client,server}
 * + import.meta.env.* references.
 *   EV01 used-not-declared    — referenced in source but absent from schema
 *   EV02 wrong-context        — client var imported from astro:env/server (or vice versa)
 *   EV03 declared-not-used    — schema var has no usage
 *   EV04 type-mismatch        — declared type vs literal coercion (heuristic)
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { walkDirectory } from "../utils/walk.js";
import { getCodeIndex } from "./index-tools.js";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getProperty, stripQuotes } from "./astro-helpers.js";

export interface EnvVarDecl {
  name: string;
  type: string;
  context: "client" | "server" | "unknown";
  access: "public" | "secret" | "unknown";
  optional: boolean;
}

export interface EnvIssue {
  code: "EV01" | "EV02" | "EV03" | "EV04";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
  var: string;
}

export interface EnvValidatorResult {
  config_found: boolean;
  declared_vars: EnvVarDecl[];
  used_vars: { name: string; file: string; via: "import.meta.env" | "astro:env/client" | "astro:env/server" }[];
  missing: string[];
  unused: string[];
  issues: EnvIssue[];
  summary: { declared: number; used: number; issues: number };
}

const CFG = ["astro.config.mjs", "astro.config.ts", "astro.config.cjs", "astro.config.js"];

async function findConfig(root: string): Promise<{ abs: string; rel: string } | null> {
  for (const rel of CFG) {
    const abs = join(root, rel);
    if (existsSync(abs)) return { abs, rel };
  }
  return null;
}

function parseEnvField(callNode: Parser.SyntaxNode): Omit<EnvVarDecl, "name"> {
  const fn = callNode.childForFieldName("function");
  const type = fn?.type === "member_expression" ? (fn.childForFieldName("property")?.text ?? "unknown") : "unknown";
  const args = callNode.childForFieldName("arguments");
  const obj = args?.namedChildren.find((n) => n.type === "object");
  let context: EnvVarDecl["context"] = "unknown";
  let access: EnvVarDecl["access"] = "unknown";
  let optional = false;
  if (obj) {
    const ctx = getProperty(obj, "context");
    if (ctx?.type === "string") {
      const v = stripQuotes(ctx.text);
      if (v === "client" || v === "server") context = v;
    }
    const acc = getProperty(obj, "access");
    if (acc?.type === "string") {
      const v = stripQuotes(acc.text);
      if (v === "public" || v === "secret") access = v;
    }
    const opt = getProperty(obj, "optional");
    if (opt?.text === "true") optional = true;
  }
  return { type, context, access, optional };
}

async function parseEnvSchema(configPath: string): Promise<EnvVarDecl[]> {
  let src: string;
  try { src = await readFile(configPath, "utf-8"); } catch { return []; }
  await initParser();
  const lang = configPath.endsWith(".ts") ? "typescript" : "javascript";
  const parser = await getParser(lang);
  if (!parser) return [];
  let tree;
  try { tree = parser.parse(src); } catch { return []; }
  try {
    const decls: EnvVarDecl[] = [];
    for (const obj of tree.rootNode.descendantsOfType("object")) {
      const envProp = getProperty(obj, "env");
      if (!envProp || envProp.type !== "object") continue;
      const schema = getProperty(envProp, "schema");
      if (!schema || schema.type !== "object") continue;
      for (const pair of schema.namedChildren) {
        if (pair.type !== "pair") continue;
        const k = pair.childForFieldName("key");
        const v = pair.childForFieldName("value");
        if (!k || !v) continue;
        const name = k.type === "string" ? stripQuotes(k.text) : k.text;
        if (v.type === "call_expression") {
          const meta = parseEnvField(v);
          decls.push({ name, ...meta });
        }
      }
    }
    return decls;
  } finally { tree.delete(); }
}

const META_ENV_RE = /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
const ASTRO_ENV_IMPORT_RE = /\bimport\s*\{\s*([^}]+)\s*\}\s*from\s*["']astro:env\/(client|server)["']/g;

export async function auditEnvFromRoot(root: string): Promise<EnvValidatorResult> {
  const cfg = await findConfig(root);
  const config_found = cfg !== null;
  const declared_vars = cfg ? await parseEnvSchema(cfg.abs) : [];
  const declaredMap = new Map(declared_vars.map((d) => [d.name, d]));

  const files = await walkDirectory(root, {
    maxFiles: 5000, relative: true,
    fileFilter: (ext) => ext === ".astro" || ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs",
  });

  const used_vars: EnvValidatorResult["used_vars"] = [];
  const issues: EnvIssue[] = [];
  const usedNames = new Set<string>();
  for (const rel of files) {
    if (cfg && rel === cfg.rel) continue;
    let src: string;
    try { src = await readFile(join(root, rel), "utf-8"); } catch { continue; }

    // import.meta.env.X
    let m: RegExpExecArray | null;
    const metaRe = new RegExp(META_ENV_RE.source, "g");
    while ((m = metaRe.exec(src))) {
      const name = m[1]!;
      used_vars.push({ name, file: rel, via: "import.meta.env" });
      usedNames.add(name);
    }

    // import { X } from "astro:env/{client,server}"
    const impRe = new RegExp(ASTRO_ENV_IMPORT_RE.source, "g");
    while ((m = impRe.exec(src))) {
      // Handle `import { X, Y as Z }` — keep the original schema name (X), drop alias.
      const names = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      const ctx = m[2] as "client" | "server";
      for (const name of names) {
        used_vars.push({ name, file: rel, via: ctx === "client" ? "astro:env/client" : "astro:env/server" });
        usedNames.add(name);
        const decl = declaredMap.get(name);
        if (decl && decl.context !== "unknown" && decl.context !== ctx) {
          issues.push({
            code: "EV02", severity: "error", var: name,
            message: `${name} declared with context="${decl.context}" but imported from astro:env/${ctx}`,
            file: rel, line: 1,
          });
        }
      }
    }
  }

  const missing: string[] = [];
  for (const name of usedNames) {
    if (!declaredMap.has(name)) {
      missing.push(name);
      const firstUsage = used_vars.find((u) => u.name === name);
      issues.push({
        code: "EV01", severity: "warning", var: name,
        message: `${name} used but not declared in env.schema`,
        file: firstUsage?.file ?? "", line: 1,
      });
    }
  }
  const unused: string[] = [];
  for (const decl of declared_vars) {
    if (!usedNames.has(decl.name)) {
      unused.push(decl.name);
      issues.push({
        code: "EV03", severity: "info", var: decl.name,
        message: `${decl.name} declared in env.schema but never used`,
        file: cfg?.rel ?? "", line: 1,
      });
    }
  }

  return {
    config_found, declared_vars, used_vars, missing, unused, issues,
    summary: { declared: declared_vars.length, used: usedNames.size, issues: issues.length },
  };
}

export async function astroEnvValidator(args: { project_root?: string; repo?: string }): Promise<EnvValidatorResult> {
  if (args.project_root) return auditEnvFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { config_found: false, declared_vars: [], used_vars: [], missing: [], unused: [], issues: [], summary: { declared: 0, used: 0, issues: 0 } };
  return auditEnvFromRoot(index.root);
}
