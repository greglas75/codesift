import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Parser from "web-tree-sitter";
import type { HonoAppModel } from "./hono-model.js";
import { stringLiteralValue, walk } from "./hono-ast-utils.js";

export class HonoRuntimeExtractor {
  /**
   * Post-parse runtime upgrade. Scans files_used for Cloudflare Worker type
   * references split into imported bindings/types files.
   */
  async upgradeRuntimeFromImports(
    filesUsed: readonly string[],
  ): Promise<HonoAppModel["runtime"]> {
    for (const file of filesUsed) {
      let source: string;
      try {
        source = await readFile(file, "utf-8");
      } catch {
        continue;
      }
      if (hasCloudflareBindingsType(source)) return "cloudflare";
    }
    return "unknown";
  }

  /** Detect Hono runtime from project files and source patterns. */
  async detectRuntime(entryFile: string): Promise<HonoAppModel["runtime"]> {
    const dir = path.dirname(entryFile);
    const projectRoot = path.dirname(dir);
    if (existsSync(path.join(projectRoot, "wrangler.toml")) ||
        existsSync(path.join(dir, "wrangler.toml"))) {
      return "cloudflare";
    }

    let source: string;
    try {
      source = await readFile(entryFile, "utf-8");
    } catch {
      return "unknown";
    }
    if (source.includes("Deno.serve")) return "deno";
    if (source.includes("Bun.serve")) return "bun";
    if (source.includes("@hono/node-server") || source.includes("serve({ fetch")) {
      return "node";
    }
    if (source.includes("hono/aws-lambda") || source.includes("handle(")) {
      return "lambda";
    }
    return detectRuntimeAdvanced(source, projectRoot);
  }

  /**
   * Extract env bindings from c.env member access, c.env destructuring, and
   * Bindings type literals in Hono/createFactory generic arguments.
   */
  extractEnvBindings(
    root: Parser.SyntaxNode,
    source: string,
    model: HonoAppModel,
  ): void {
    const bindings = new Set<string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      collectEnvMemberAccess(node, bindings);
      collectEnvDestructuring(node, bindings);
    });

    const bindingsMatch = source.match(/Bindings\s*:\s*\{([^}]+)\}/);
    if (bindingsMatch?.[1]) {
      const propRegex = /(\w+)\s*:/g;
      let match: RegExpExecArray | null;
      while ((match = propRegex.exec(bindingsMatch[1])) !== null) {
        if (match[1]) bindings.add(match[1]);
      }
    }

    model.env_bindings = [...bindings].sort();
  }
}

function detectRuntimeAdvanced(
  source: string,
  projectRoot: string,
): HonoAppModel["runtime"] {
  if (hasCloudflareBindingsType(source)) return "cloudflare";
  if (existsSync(path.join(projectRoot, "vercel.json"))) return "vercel";
  if (
    existsSync(path.join(projectRoot, "netlify.toml")) ||
    existsSync(path.join(projectRoot, "netlify", "functions"))
  ) {
    return "netlify";
  }
  if (existsSync(path.join(projectRoot, "fly.toml"))) return "fly";
  return "unknown";
}

function collectEnvMemberAccess(
  node: Parser.SyntaxNode,
  bindings: Set<string>,
): void {
  if (node.type !== "member_expression") return;
  const obj = node.childForFieldName("object");
  const prop = node.childForFieldName("property");
  if (obj?.type !== "member_expression" || !prop) return;

  const innerObj = obj.childForFieldName("object");
  const innerProp = obj.childForFieldName("property");
  if (innerObj?.text === "c" && innerProp?.text === "env") {
    bindings.add(prop.text);
  }
}

function collectEnvDestructuring(
  node: Parser.SyntaxNode,
  bindings: Set<string>,
): void {
  if (node.type !== "variable_declarator") return;
  const nameNode = node.childForFieldName("name");
  const valueNode = node.childForFieldName("value");
  if (nameNode?.type !== "object_pattern" || valueNode?.type !== "member_expression") {
    return;
  }

  const obj = valueNode.childForFieldName("object");
  const prop = valueNode.childForFieldName("property");
  if (obj?.text !== "c" || prop?.text !== "env") return;

  for (const child of nameNode.namedChildren) {
    if (
      child.type === "shorthand_property_identifier_pattern" ||
      child.type === "shorthand_property_identifier"
    ) {
      bindings.add(child.text);
    }
    if (child.type === "pair_pattern") {
      const key = child.childForFieldName("key");
      if (key) {
        const bindingName = stringLiteralValue(key) ?? key.text;
        bindings.add(bindingName);
      }
    }
  }
}

const CF_WORKER_TYPES = [
  "KVNamespace",
  "D1Database",
  "R2Bucket",
  "DurableObjectNamespace",
  "AnalyticsEngineDataset",
];

function hasCloudflareBindingsType(source: string): boolean {
  for (const cfType of CF_WORKER_TYPES) {
    const regex = new RegExp(`\\b${cfType}\\b`);
    if (regex.test(source)) return true;
  }
  return false;
}
