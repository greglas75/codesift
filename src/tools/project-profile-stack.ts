import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { fileExists, readJson } from "./project-profile-fs.js";
import type { StackInfo } from "./project-profile-types.js";

export async function detectStack(projectRoot: string): Promise<StackInfo> {
  const detected_from: string[] = [];
  const pkg = await readJson(join(projectRoot, "package.json"));

  // Framework detection
  let framework: string | null = null;
  let framework_version: string | null = null;

  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    const frameworkMap: [string, string][] = [
      ["hono", "hono"],
      ["@nestjs/core", "nestjs"],
      ["next", "nextjs"],
      ["nuxt", "nuxt"],
      ["@remix-run/node", "remix"],
      ["astro", "astro"],
      ["express", "express"],
      ["fastify", "fastify"],
      ["@angular/core", "angular"],
      ["vue", "vue"],
      ["svelte", "svelte"],
    ];

    for (const [dep, name] of frameworkMap) {
      if (allDeps?.[dep]) {
        framework = name;
        framework_version = allDeps[dep]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push(`package.json:dependencies.${dep}`);
        break;
      }
    }

    // React detection (only if no framework found — React is often a sub-dep)
    if (!framework && allDeps?.["react"]) {
      framework = "react";
      framework_version = allDeps["react"]?.replace(/^[\^~>=<]/, "") ?? null;
      detected_from.push("package.json:dependencies.react");
    }
  }

  // Python framework detection (if no JS framework found)
  if (!framework) {
    const pyproject = await readFile(join(projectRoot, "pyproject.toml"), "utf-8").catch(() => "");
    const requirements = await readFile(join(projectRoot, "requirements.txt"), "utf-8").catch(() => "");
    const pipfile = await readFile(join(projectRoot, "Pipfile"), "utf-8").catch(() => "");
    const pyDeps = `${requirements}\n${pipfile}\n${pyproject}`.toLowerCase();

    if (pyDeps.includes("fastapi")) {
      framework = "fastapi";
      detected_from.push("python:fastapi");
    } else if (pyDeps.includes("django")) {
      framework = "django";
      detected_from.push("python:django");
    } else if (pyDeps.includes("flask")) {
      framework = "flask";
      detected_from.push("python:flask");
    }
  }

  // PHP framework detection
  if (!framework) {
    const composer = await readJson(join(projectRoot, "composer.json"));
    if (composer) {
      const phpDeps = { ...composer.require, ...composer["require-dev"] };
      if (phpDeps?.["laravel/framework"]) {
        framework = "laravel";
        framework_version = phpDeps["laravel/framework"]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push("composer.json:require.laravel/framework");
      } else if (phpDeps?.["yiisoft/yii2"]) {
        framework = "yii2";
        framework_version = phpDeps["yiisoft/yii2"]?.replace(/^[\^~>=<]/, "") ?? null;
        detected_from.push("composer.json:require.yiisoft/yii2");
      } else if (phpDeps?.["symfony/framework-bundle"]) {
        framework = "symfony";
        detected_from.push("composer.json:require.symfony/framework-bundle");
      }
    }
  }

  // Language detection
  let language = "javascript";
  let language_version: string | null = null;

  // Check for Python first
  if (["fastapi", "django", "flask"].includes(framework ?? "")) {
    language = "python";
    detected_from.push("framework implies python");
  } else if (await fileExists(join(projectRoot, "pyproject.toml")) || await fileExists(join(projectRoot, "requirements.txt"))) {
    language = "python";
    detected_from.push("pyproject.toml or requirements.txt");
  }

  // Check for PHP
  if (["laravel", "symfony", "yii2"].includes(framework ?? "")) {
    language = "php";
    detected_from.push("framework implies php");
  }

  // TypeScript/JavaScript (only if not already Python/PHP)
  if (language === "javascript") {
    const tsconfig = await readJson(join(projectRoot, "tsconfig.json"));
    if (tsconfig) {
      language = "typescript";
      language_version = tsconfig?.compilerOptions?.target ?? null;
      detected_from.push("tsconfig.json");
    }
  }

  // Test runner detection
  let test_runner: string | null = null;
  if (language === "python") {
    if (await fileExists(join(projectRoot, "pytest.ini")) || await fileExists(join(projectRoot, "conftest.py"))) {
      test_runner = "pytest";
      detected_from.push("pytest.ini or conftest.py");
    }
  } else if (language === "php") {
    if (await fileExists(join(projectRoot, "phpunit.xml")) || await fileExists(join(projectRoot, "phpunit.xml.dist"))) {
      test_runner = "phpunit";
      detected_from.push("phpunit.xml");
    }
  } else if (pkg) {
    const devDeps = pkg.devDependencies ?? {};
    if (devDeps["vitest"]) {
      test_runner = "vitest";
      detected_from.push("package.json:devDependencies.vitest");
    } else if (devDeps["jest"]) {
      test_runner = "jest";
      detected_from.push("package.json:devDependencies.jest");
    } else if (devDeps["mocha"]) {
      test_runner = "mocha";
      detected_from.push("package.json:devDependencies.mocha");
    }
  }

  // Package manager detection
  let package_manager: string | null = null;
  if (await fileExists(join(projectRoot, "pnpm-lock.yaml"))) {
    package_manager = "pnpm";
    detected_from.push("pnpm-lock.yaml");
  } else if (await fileExists(join(projectRoot, "yarn.lock"))) {
    package_manager = "yarn";
    detected_from.push("yarn.lock");
  } else if (await fileExists(join(projectRoot, "package-lock.json"))) {
    package_manager = "npm";
    detected_from.push("package-lock.json");
  } else if (await fileExists(join(projectRoot, "bun.lockb"))) {
    package_manager = "bun";
    detected_from.push("bun.lockb");
  }

  // Monorepo detection — resolveWorkspaces() (Task 4) is the primary path.
  // Falls back to the legacy regex YAML parser when resolveWorkspaces returns
  // null (covers @manypkg's edge cases such as malformed configs).
  let monorepo: StackInfo["monorepo"] = null;

  // Read raw workspace globs from manifest first — they are the canonical
  // shape exposed by `monorepo.workspaces` (string[] of patterns).
  let manifestWorkspaces: string[] | null = null;
  if (pkg?.workspaces) {
    manifestWorkspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces.packages ?? [];
    detected_from.push("package.json:workspaces");
  } else if (await fileExists(join(projectRoot, "pnpm-workspace.yaml"))) {
    try {
      const content = await readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf-8");
      manifestWorkspaces =
        content.match(/- ['"]?([^'"]+)['"]?/g)?.map((m) =>
          m.replace(/- ['"]?/, "").replace(/['"]$/, ""),
        ) ?? [];
      detected_from.push("pnpm-workspace.yaml");
    } catch {
      /* ignore parse errors */
    }
  }

  if (manifestWorkspaces) {
    const turboExists = await fileExists(join(projectRoot, "turbo.json"));
    const nxExists = await fileExists(join(projectRoot, "nx.json"));
    const tool = turboExists
      ? "turborepo"
      : nxExists
        ? "nx"
        : pkg?.workspaces
          ? "workspaces"
          : "pnpm-workspaces";

    // Try the rich resolver (Task 4) — graceful degradation if it returns null
    let workspace_details: import("../types.js").Workspace[] | undefined;
    try {
      const { resolveWorkspaces } = await import("../storage/workspace-resolver.js");
      const resolved = await resolveWorkspaces(projectRoot);
      if (resolved) {
        workspace_details = resolved.workspaces;
        detected_from.push("workspace-resolver");
      }
    } catch {
      /* fall back to manifest-only data — graceful */
    }

    monorepo = {
      tool,
      workspaces: manifestWorkspaces,
      ...(workspace_details ? { workspace_details } : {}),
    };
  }

  // Monorepo workspace scanning — if root has no framework/test_runner, scan workspaces
  if (monorepo && (!framework || !test_runner || language === "javascript")) {
    const workspacePatterns = monorepo.workspaces;
    const workspaceDirs: string[] = [];

    for (const pattern of workspacePatterns) {
      // Expand simple glob patterns like "apps/*" or "packages/*"
      const base = pattern.replace(/\/?\*$/, "");
      const baseDir = join(projectRoot, base);
      try {
        const entries = await readdir(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            workspaceDirs.push(join(baseDir, entry.name));
          }
        }
      } catch { /* directory doesn't exist */ }
    }

    const frameworkMap: [string, string][] = [
      ["hono", "hono"],
      ["@nestjs/core", "nestjs"],
      ["next", "nextjs"],
      ["nuxt", "nuxt"],
      ["@remix-run/node", "remix"],
      ["astro", "astro"],
      ["express", "express"],
      ["fastify", "fastify"],
    ];

    for (const wsDir of workspaceDirs) {
      const wsPkg = await readJson(join(wsDir, "package.json"));
      if (!wsPkg) continue;
      const wsDeps = { ...wsPkg.dependencies, ...wsPkg.devDependencies };
      const wsName = relative(projectRoot, wsDir);

      // Framework from workspace (prefer backend frameworks: hono, nestjs, express)
      if (!framework) {
        for (const [dep, name] of frameworkMap) {
          if (wsDeps?.[dep]) {
            framework = name;
            framework_version = wsDeps[dep]?.replace(/^[\^~>=<]/, "") ?? null;
            detected_from.push(`${wsName}/package.json:dependencies.${dep}`);
            break;
          }
        }
      }

      // Test runner from workspace
      if (!test_runner) {
        if (wsDeps?.["vitest"]) {
          test_runner = "vitest";
          detected_from.push(`${wsName}/package.json:devDependencies.vitest`);
        } else if (wsDeps?.["jest"]) {
          test_runner = "jest";
          detected_from.push(`${wsName}/package.json:devDependencies.jest`);
        }
      }

      // TypeScript from workspace
      if (language === "javascript") {
        const wsTsconfig = await readJson(join(wsDir, "tsconfig.json"));
        if (wsTsconfig) {
          language = "typescript";
          language_version = wsTsconfig?.compilerOptions?.target ?? null;
          detected_from.push(`${wsName}/tsconfig.json`);
        }
      }
    }
  }

  // Also check root tsconfig.base.json for monorepos that use base config
  if (language === "javascript") {
    const baseTsconfig = await readJson(join(projectRoot, "tsconfig.base.json"));
    if (baseTsconfig) {
      language = "typescript";
      language_version = baseTsconfig?.compilerOptions?.target ?? null;
      detected_from.push("tsconfig.base.json");
    }
  }

  // Build tool detection (Vite, CRA, webpack, Parcel, esbuild, Rspack, Turbopack)
  // Order matters: check more specific/modern tools first.
  let build_tool: string | null = null;
  if (pkg) {
    const devDeps = pkg.devDependencies ?? {};
    const deps = pkg.dependencies ?? {};
    const allDeps: Record<string, string> = { ...deps, ...devDeps };

    if (allDeps["vite"]) {
      build_tool = "vite";
      detected_from.push("package.json:vite");
    } else if (allDeps["react-scripts"]) {
      build_tool = "cra";
      detected_from.push("package.json:react-scripts");
    } else if (allDeps["@rsbuild/core"]) {
      build_tool = "rsbuild";
      detected_from.push("package.json:@rsbuild/core");
    } else if (allDeps["@rspack/cli"] || allDeps["@rspack/core"]) {
      build_tool = "rspack";
      detected_from.push("package.json:@rspack/*");
    } else if (allDeps["parcel"] || allDeps["parcel-bundler"]) {
      build_tool = "parcel";
      detected_from.push("package.json:parcel");
    } else if (allDeps["webpack"] || allDeps["webpack-cli"]) {
      build_tool = "webpack";
      detected_from.push("package.json:webpack");
    } else if (allDeps["esbuild"]) {
      build_tool = "esbuild";
      detected_from.push("package.json:esbuild");
    } else if (allDeps["turbopack"]) {
      build_tool = "turbopack";
      detected_from.push("package.json:turbopack");
    }
  }

  // Fallback: look for config files if no dep match
  if (!build_tool) {
    const configChecks: [string, string][] = [
      ["vite.config.ts", "vite"],
      ["vite.config.js", "vite"],
      ["vite.config.mjs", "vite"],
      ["webpack.config.js", "webpack"],
      ["webpack.config.ts", "webpack"],
      ["rspack.config.js", "rspack"],
      ["rsbuild.config.ts", "rsbuild"],
      [".parcelrc", "parcel"],
    ];
    for (const [file, tool] of configChecks) {
      if (await fileExists(join(projectRoot, file))) {
        build_tool = tool;
        detected_from.push(file);
        break;
      }
    }
  }

  return {
    framework,
    framework_version,
    language,
    language_version,
    test_runner,
    package_manager,
    build_tool,
    monorepo,
    detected_from,
  };
}
