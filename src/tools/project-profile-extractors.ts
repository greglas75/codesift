import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { CodeIndex, FileEntry } from "../types.js";
import { fileExists, readJson } from "./project-profile-fs.js";
import { buildImporterCountFromSources } from "./project-profile-imports.js";
import type {
  DependencyGraph,
  DependencyHealth,
  GitHealth,
  KnownGotchas,
  ProjectIdentity,
  TestConventions,
} from "./project-profile-types.js";

const execFileAsync = promisify(execFile);

function sanitizeGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "").replace(/\.git$/, "");
  } catch {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:]+):(.+)$/);
    if (scpLike) {
      return `${scpLike[1]}/${scpLike[2]}`.replace(/\.git$/, "");
    }

    const schemeIndex = trimmed.indexOf("://");
    if (schemeIndex >= 0) {
      const authorityStart = schemeIndex + 3;
      const pathStart = trimmed.indexOf("/", authorityStart);
      const authorityEnd = pathStart === -1 ? trimmed.length : pathStart;
      const authority = trimmed.slice(authorityStart, authorityEnd);
      const authEnd = authority.lastIndexOf("@");
      if (authEnd >= 0) {
        return `${trimmed.slice(0, authorityStart)}${authority.slice(authEnd + 1)}${trimmed.slice(authorityEnd)}`.replace(/\.git$/, "");
      }
    }

    return trimmed.replace(/^(.*:\/\/)?.*@/, "$1").replace(/\.git$/, "");
  }
}

export async function extractIdentity(projectRoot: string): Promise<ProjectIdentity> {
  const pkg = await readJson(join(projectRoot, "package.json"));
  const projectName = pkg?.name ?? basename(projectRoot) ?? "unknown";

  const isMonorepo = !!(pkg?.workspaces
    || await fileExists(join(projectRoot, "pnpm-workspace.yaml"))
    || await fileExists(join(projectRoot, "lerna.json")));

  let gitRemote: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectRoot, timeout: 3000,
    });
    gitRemote = sanitizeGitRemote(stdout.toString());
  } catch {
    // Not a git repo, or no remote is configured.
  }

  return {
    project_name: projectName,
    project_type: isMonorepo ? "monorepo" : "single",
    workspace_root: projectRoot,
    git_remote: gitRemote,
  };
}

export function extractDependencyGraph(
  index: CodeIndex,
  importCount: Map<string, number> = buildImporterCountFromSources(index),
): DependencyGraph {
  const entry_points: string[] = [];
  const isTestPath = (path: string) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(path);

  for (const file of index.files) {
    if (/(^|\/)(app|main|server)\.(ts|js|tsx)$/.test(file.path)) entry_points.push(file.path);
    if (/^(src\/)?index\.(ts|js)$/.test(file.path)) entry_points.push(file.path);
  }

  const hub_modules = [...importCount.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, imported_by_count: count }));

  const importedFiles = new Set(importCount.keys());
  const leaf_modules = index.files
    .filter((file) => !importedFiles.has(file.path) && !isTestPath(file.path))
    .slice(0, 30)
    .map((file) => file.path);

  const orphan_files = index.files
    .filter((file) => {
      return !importedFiles.has(file.path) && file.symbol_count === 0 && !isTestPath(file.path);
    })
    .slice(0, 20)
    .map((file) => file.path);

  return { entry_points, hub_modules, leaf_modules, orphan_files };
}

function buildTestFilePatterns(testFiles: FileEntry[]): string[] {
  return [...new Set(testFiles.map((file) => {
    if (file.path.includes(".test.")) return "*.test.*";
    if (file.path.includes(".spec.")) return "*.spec.*";
    return "*.test.*";
  }))];
}

function findSetupFiles(files: FileEntry[]): string[] {
  const setupFiles = new Set<string>();
  for (const file of files) {
    if (/setup\.(ts|js)$/.test(file.path) && !/(node_modules|dist|\.next)/.test(file.path)) {
      setupFiles.add(file.path);
    }
    if (/vitest\.setup\.(ts|js)$/.test(file.path)) setupFiles.add(file.path);
    if (/jest\.setup\.(ts|js)$/.test(file.path)) setupFiles.add(file.path);
  }
  return [...setupFiles];
}

function getSampleTests(testFiles: FileEntry[]): FileEntry[] {
  const targetedTests = testFiles
    .filter((file) => file.path.includes("service") || file.path.includes("controller") || file.path.includes("guard"))
    .slice(0, 5);
  return targetedTests.length > 0 ? targetedTests : testFiles.slice(0, 5);
}

function detectMockStyle(content: string): string | null {
  if (content.includes("vi.mock")) return "vi.mock";
  if (content.includes("jest.mock")) return "jest.mock";
  if (content.includes("sinon")) return "sinon";
  return null;
}

function collectMockCalls(content: string, commonMocks: Set<string>): void {
  const mockCalls = content.match(/(?:vi|jest)\.mock\s*\(\s*['"]([^'"]+)['"]/g);
  if (!mockCalls) return;

  for (const mockCall of mockCalls) {
    const path = mockCall.match(/['"]([^'"]+)['"]/)?.[1];
    if (path) commonMocks.add(path);
  }
}

function pushMockPattern(
  mockPatterns: TestConventions["mock_patterns"],
  pattern: TestConventions["mock_patterns"][number],
): void {
  if (!mockPatterns.some((existing) => existing.name === pattern.name)) {
    mockPatterns.push(pattern);
  }
}

function collectNamedMockPatterns(content: string, mockPatterns: TestConventions["mock_patterns"]): void {
  if (content.includes("mockPrismaClient") || content.includes("prismaMock")) {
    pushMockPattern(mockPatterns, { name: "prisma", import_from: "setup or inline", usage: "mockPrismaClient / prismaMock" });
  }
  if (content.includes("mockDeep") || content.includes("DeepMockProxy")) {
    pushMockPattern(mockPatterns, { name: "deep-mock", import_from: "vitest-mock-extended or jest-mock-extended", usage: "mockDeep<Type>()" });
  }
  if (content.includes("$transaction") && content.includes("mock")) {
    pushMockPattern(mockPatterns, { name: "transaction", import_from: "prisma mock", usage: "$transaction mock for DB operations" });
  }
}

async function readSampleTestConventions(
  projectRoot: string,
  sampleTests: FileEntry[],
  mockPatterns: TestConventions["mock_patterns"],
  commonMocks: Set<string>,
): Promise<string | null> {
  let mockStyle: string | null = null;

  for (const testFile of sampleTests) {
    try {
      const content = await readFile(join(projectRoot, testFile.path), "utf-8");
      mockStyle ??= detectMockStyle(content);
      collectMockCalls(content, commonMocks);
      collectNamedMockPatterns(content, mockPatterns);
    } catch {
      // Skip unreadable files.
    }
  }

  return mockStyle;
}

async function collectSetupMockPatterns(
  projectRoot: string,
  setupFiles: string[],
  mockPatterns: TestConventions["mock_patterns"],
): Promise<void> {
  for (const setupFile of setupFiles) {
    try {
      const content = await readFile(join(projectRoot, setupFile), "utf-8");
      const exports = content.match(/export\s+(?:const|function|class)\s+(\w+)/g);
      if (!exports) continue;

      for (const exported of exports) {
        const name = exported.match(/(\w+)$/)?.[1];
        if (name && /mock|stub|fake|fixture|factory/i.test(name)) {
          mockPatterns.push({ name, import_from: setupFile, usage: "shared test helper" });
        }
      }
    } catch {
      // Skip unreadable setup files.
    }
  }
}

async function detectAssertionLibrary(projectRoot: string): Promise<string> {
  const pkg = await readJson(join(projectRoot, "package.json"));
  const devDeps = pkg?.devDependencies ?? {};
  if (devDeps["vitest"]) return "vitest/expect";
  if (devDeps["jest"]) return "jest/expect";
  if (devDeps["chai"]) return "chai";
  return "expect";
}

export async function extractTestConventions(
  projectRoot: string,
  index: CodeIndex,
): Promise<TestConventions> {
  const testFiles = index.files.filter((file) => /(test|spec)\.(ts|js|tsx|jsx)$/.test(file.path));
  const file_patterns = buildTestFilePatterns(testFiles);
  const setup_files = findSetupFiles(index.files);
  const mock_patterns: TestConventions["mock_patterns"] = [];
  const common_mocks_set = new Set<string>();
  const sampleTests = getSampleTests(testFiles);

  const mock_style = await readSampleTestConventions(projectRoot, sampleTests, mock_patterns, common_mocks_set);
  await collectSetupMockPatterns(projectRoot, setup_files, mock_patterns);
  const assertion_library = await detectAssertionLibrary(projectRoot);

  return {
    mock_style,
    setup_files,
    mock_patterns: mock_patterns.slice(0, 10),
    assertion_library,
    file_patterns,
    common_mocks: [...common_mocks_set].slice(0, 20),
  };
}

export function extractKnownGotchas(index: CodeIndex): KnownGotchas {
  const gotchas: KnownGotchas["auto_detected"] = [];
  const processEnvEvidence = new Set<string>();

  for (const sym of index.symbols) {
    if (!sym.source) continue;
    if (/(test|spec)\.(ts|js|tsx|jsx)$/.test(sym.file)) continue;

    if (/process\.env\.\w+/.test(sym.source) && !/config|env\.schema|validate/.test(sym.file)) {
      processEnvEvidence.add(sym.file);
    }
  }

  if (processEnvEvidence.size > 0) {
    gotchas.push({
      gotcha: "scattered process.env access outside config module",
      evidence: [...processEnvEvidence].slice(0, 20),
      severity: "medium",
    });
  }

  const hasEslintIgnore = index.files.some((file) => file.path.includes(".eslintignore"));
  if (hasEslintIgnore) {
    gotchas.push({
      gotcha: ".eslintignore present — some files bypass linting",
      evidence: [".eslintignore"],
      severity: "low",
    });
  }

  return { auto_detected: gotchas.slice(0, 10) };
}

export async function extractDependencyHealth(projectRoot: string): Promise<DependencyHealth | null> {
  const pkg = await readJson(join(projectRoot, "package.json"));
  if (!pkg) {
    const hasPythonManifest = await fileExists(join(projectRoot, "pyproject.toml"))
      || await fileExists(join(projectRoot, "requirements.txt"));
    if (!hasPythonManifest) return null;
    return { total: 0, prod: 0, dev: 0, key_versions: {} };
  }

  const prod = Object.keys(pkg.dependencies ?? {});
  const dev = Object.keys(pkg.devDependencies ?? {});
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const keyPackages = [
    "react", "next", "hono", "@nestjs/core", "express", "vue", "angular",
    "typescript", "vitest", "jest", "prisma", "@prisma/client",
    "tailwindcss", "@anthropic-ai/sdk", "openai",
    "stripe", "inngest", "@clerk/nextjs", "@clerk/backend",
    "@sentry/nextjs", "@sentry/nestjs", "drizzle-orm",
  ];

  const key_versions: Record<string, string> = {};
  for (const keyPackage of keyPackages) {
    if (allDeps[keyPackage]) key_versions[keyPackage] = allDeps[keyPackage];
  }

  return {
    total: prod.length + dev.length,
    prod: prod.length,
    dev: dev.length,
    key_versions,
  };
}

export async function extractGitHealth(projectRoot: string): Promise<GitHealth | null> {
  try {
    const totalRes = await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
      cwd: projectRoot, timeout: 5000,
    });
    const totalStr = totalRes.stdout.toString().trim();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentRes = await execFileAsync("git", ["rev-list", "--count", `--since=${thirtyDaysAgo}`, "HEAD"], {
      cwd: projectRoot, timeout: 5000,
    });
    const recentStr = recentRes.stdout.toString().trim();

    const lastRes = await execFileAsync("git", ["log", "-1", "--format=%aI"], {
      cwd: projectRoot, timeout: 5000,
    });
    const lastCommitDate = lastRes.stdout.toString().trim();

    let contributors = 0;
    try {
      const contribRes = await execFileAsync("git", ["shortlog", "-sn", "--no-merges", "HEAD"], {
        cwd: projectRoot, timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const contributorsStr = contribRes.stdout.toString().trim();
      contributors = contributorsStr.split("\n").filter(Boolean).length;
    } catch {
      contributors = 0;
    }

    return {
      total_commits: parseInt(totalStr) || 0,
      recent_commits_30d: parseInt(recentStr) || 0,
      last_commit_date: lastCommitDate || null,
      contributors,
    };
  } catch {
    return null;
  }
}
