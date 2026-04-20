/**
 * Non-JS manifest parsers + key-dependency selector for buildProjectOverview.
 * Narrow scope by design — we only extract the few fields the wiki overview
 * needs, not full TOML/Go-module parse trees.
 */
import type { DependencySummary } from "./wiki-manifest.js";
import type { ProjectProfile } from "./project-tools.js";
import { execFileSync } from "node:child_process";

export interface GoModSummary { name: string | null; deps: string[] }
export interface TomlProjectSummary {
  name: string | null;
  version: string | null;
  description: string | null;
  deps: string[];
}

export function parseGoMod(source: string): GoModSummary {
  const nameMatch = source.match(/^module\s+(\S+)/m);
  const deps: string[] = [];
  const requireBlock = source.match(/require\s*\(([^)]*)\)/);
  if (requireBlock?.[1]) {
    for (const line of requireBlock[1].split("\n")) {
      const m = line.trim().match(/^([^\s]+)\s+/);
      if (m?.[1]) deps.push(m[1]);
    }
  }
  for (const m of source.matchAll(/^require\s+([^\s]+)\s+/gm)) {
    if (m[1]) deps.push(m[1]);
  }
  return { name: nameMatch?.[1] ?? null, deps };
}

/** Narrow regex-based parse of pyproject.toml `[project]` section. */
export function parsePyprojectToml(source: string): TomlProjectSummary {
  const section = extractTomlSection(source, "project");
  const name = matchTomlKey(section, "name");
  const version = matchTomlKey(section, "version");
  const description = matchTomlKey(section, "description");
  const deps: string[] = [];
  const depsArray = section.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (depsArray?.[1]) {
    for (const m of depsArray[1].matchAll(/"([^"]+)"/g)) {
      // e.g. "fastapi>=0.100" -> fastapi
      const base = m[1]!.split(/[<>=\s!~]/)[0];
      if (base) deps.push(base);
    }
  }
  return { name, version, description, deps };
}

export function parseCargoToml(source: string): TomlProjectSummary {
  const section = extractTomlSection(source, "package");
  const depsSection = extractTomlSection(source, "dependencies");
  const deps: string[] = [];
  for (const m of depsSection.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) {
    if (m[1]) deps.push(m[1]);
  }
  return {
    name: matchTomlKey(section, "name"),
    version: matchTomlKey(section, "version"),
    description: matchTomlKey(section, "description"),
    deps,
  };
}

function extractTomlSection(source: string, name: string): string {
  // Find the header line, then capture everything until the next section header
  // or end of input.
  const lines = source.split("\n");
  const headerRe = new RegExp(`^\\[${name}\\]\\s*$`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!)) { startIdx = i + 1; break; }
  }
  if (startIdx < 0) return "";
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (/^\[[^\]]+\]\s*$/.test(lines[i]!)) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function matchTomlKey(section: string, key: string): string | null {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m?.[1] ?? null;
}

/** Detect shallow clone (git rev-parse --is-shallow-repository). Safe on
 *  missing git binary / non-repo / permission errors. */
export function isShallowClone(root: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim() === "true";
  } catch {
    return false;
  }
}

/** Architectural relevance table for selectKeyDependencies. */
const ARCH_RELEVANT = new Set([
  // Frameworks
  "react", "next", "vue", "angular", "svelte", "solid-js", "nuxt", "gatsby", "remix",
  "express", "fastify", "hono", "@nestjs/core", "koa", "hapi",
  "fastapi", "flask", "django", "pyramid", "starlette",
  // DB / ORM
  "prisma", "@prisma/client", "pg", "mysql2", "mongodb", "mongoose", "drizzle-orm",
  "typeorm", "sequelize", "redis", "ioredis", "sqlalchemy", "peewee",
  // Testing
  "vitest", "jest", "mocha", "cypress", "playwright", "pytest",
  // Build / bundler
  "vite", "webpack", "rollup", "esbuild", "parcel", "tsup", "turbopack",
  // Language / type
  "typescript", "ts-node", "tsx",
  // Validation / schema
  "zod", "yup", "joi", "pydantic",
  // State / data
  "zustand", "redux", "@tanstack/react-query", "swr", "graphql", "apollo-server",
  "@trpc/server",
]);

export function selectKeyDependencies(projectResult: ProjectProfile): DependencySummary {
  const dh = (projectResult as unknown as { dependency_health?: { prod?: number; dev?: number; key_versions?: Record<string, string> } }).dependency_health;
  const prodTotal = dh?.prod ?? 0;
  const devTotal = dh?.dev ?? 0;
  const key: DependencySummary["key"] = [];
  const kv = dh?.key_versions ?? {};
  for (const [name, version] of Object.entries(kv)) {
    if (key.length >= 15) break;
    const kind: "prod" | "dev" = ARCH_RELEVANT.has(name) ? "prod" : "prod";
    key.push({ name, version: String(version), kind });
  }
  return { prod_total: prodTotal, dev_total: devTotal, key };
}
