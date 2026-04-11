/**
 * pyproject.toml parsing — extract dependencies, Python version,
 * build system, configured tools, and entry points.
 *
 * Uses simple regex-based TOML parsing for the key sections.
 * Does not require a full TOML parser dependency.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

export interface PyprojectInfo {
  name?: string;
  version?: string;
  requires_python?: string;
  build_system?: string;
  dependencies: Array<{ name: string; version: string }>;
  optional_dependencies: Record<string, string[]>;
  scripts: Record<string, string>;
  configured_tools: string[];
  source_file: string;
}

/**
 * Parse pyproject.toml from the repository root.
 */
export async function parsePyproject(
  repo: string,
): Promise<PyprojectInfo | null> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePath = join(index.root, "pyproject.toml");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null; // No pyproject.toml found
  }

  return parsePyprojectContent(content, "pyproject.toml");
}

/**
 * Parse pyproject.toml content string. Exported for testing.
 */
export function parsePyprojectContent(
  content: string,
  sourcePath: string,
): PyprojectInfo {
  const info: PyprojectInfo = {
    dependencies: [],
    optional_dependencies: {},
    scripts: {},
    configured_tools: [],
    source_file: sourcePath,
  };

  // [project] section
  const name = extractValue(content, "name");
  if (name) info.name = name;
  const version = extractValue(content, "version");
  if (version) info.version = version;
  const requiresPython = extractValue(content, "requires-python");
  if (requiresPython) info.requires_python = requiresPython;

  // [build-system]
  const buildReq = extractValue(content, "build-backend");
  if (buildReq) {
    info.build_system = buildReq;
  }

  // dependencies = [...] — multi-line TOML array (may contain [] in extras like pydantic[email])
  const depsMatch = content.match(/^dependencies\s*=\s*\[([\s\S]*?)\n\]/m);
  if (depsMatch) {
    info.dependencies = parseDependencyList(depsMatch[1]!);
  }

  // [project.optional-dependencies]
  const optDepsSection = extractSection(content, "project.optional-dependencies");
  if (optDepsSection) {
    const optGroups = optDepsSection.matchAll(/^(\w[\w-]*)\s*=\s*\[([\s\S]*?)\n\]/gm);
    for (const m of optGroups) {
      const groupName = m[1]!;
      const deps = parseDependencyNames(m[2]!);
      info.optional_dependencies[groupName] = deps;
    }
  }

  // [project.scripts]
  const scriptsSection = extractSection(content, "project.scripts");
  if (scriptsSection) {
    const entries = scriptsSection.matchAll(/^([\w][\w-]*)\s*=\s*"([^"]+)"/gm);
    for (const m of entries) {
      info.scripts[m[1]!] = m[2]!;
    }
  }

  // Detect configured tools
  const toolSections = content.matchAll(/^\[tool\.(\w+)/gm);
  for (const m of toolSections) {
    info.configured_tools.push(m[1]!);
  }

  return info;
}

// --- Helpers ---

function extractValue(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key.replace("-", "[-_]")}\\s*=\\s*"([^"]*)"`, "m");
  const match = re.exec(content);
  return match?.[1];
}

function extractSection(content: string, sectionName: string): string | undefined {
  const escaped = sectionName.replace(/\./g, "\\.");
  const headerIdx = content.search(new RegExp(`^\\[${escaped}\\]`, "m"));
  if (headerIdx === -1) return undefined;

  // Find the start of content (after the [section] line)
  const afterHeader = content.indexOf("\n", headerIdx);
  if (afterHeader === -1) return undefined;

  // Find the next section header or end of content
  const nextSection = content.slice(afterHeader + 1).search(/^\[/m);
  if (nextSection === -1) return content.slice(afterHeader + 1);
  return content.slice(afterHeader + 1, afterHeader + 1 + nextSection);
}

function parseDependencyList(block: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const entries = block.matchAll(/["']([^"']+)["']/g);
  for (const m of entries) {
    const raw = m[1]!;
    const parsed = parseDependencySpec(raw);
    if (parsed) deps.push(parsed);
  }
  return deps;
}

function parseDependencyNames(block: string): string[] {
  const names: string[] = [];
  const entries = block.matchAll(/["']([^"']+)["']/g);
  for (const m of entries) {
    const name = m[1]!.split(/[><=~!;@\[]/)[0]!.trim();
    if (name) names.push(name);
  }
  return names;
}

function parseDependencySpec(raw: string): { name: string; version: string } | null {
  // Examples: "django>=4.2", "flask~=3.0", "requests", "pydantic[email]>=2.0"
  const match = raw.match(/^([a-zA-Z0-9][\w.-]*)(?:\[[\w,]+\])?\s*(.*)/);
  if (!match) return null;
  return { name: match[1]!, version: match[2]?.trim() || "*" };
}
