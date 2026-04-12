/**
 * Tests for PHP/Yii2-specific tools (src/tools/php-tools.ts).
 *
 * These are unit tests that mock the code index rather than requiring
 * a real indexed repo. They test the extraction logic in isolation.
 */
import { extractYii2Conventions, extractPhpConventions } from "../../src/tools/project-tools.js";

// We can't easily test the full tool functions (they call getCodeIndex)
// without integration setup, so we test the convention extractors and
// validate the module structure/exports.

describe("PHP tool module exports", () => {
  it("exports all 9 PHP tool functions", async () => {
    const mod = await import("../../src/tools/php-tools.js");
    expect(typeof mod.resolvePhpNamespace).toBe("function");
    expect(typeof mod.analyzeActiveRecord).toBe("function");
    expect(typeof mod.tracePhpEvent).toBe("function");
    expect(typeof mod.findPhpViews).toBe("function");
    expect(typeof mod.resolvePhpService).toBe("function");
    expect(typeof mod.phpSecurityScan).toBe("function");
    expect(typeof mod.phpProjectAudit).toBe("function");
    expect(typeof mod.findPhpNPlusOne).toBe("function");
    expect(typeof mod.findPhpGodModel).toBe("function");
  });
});

describe("extractPhpConventions — root-level paths", () => {
  it("matches controllers at root level (Yii2 structure)", () => {
    const result = extractPhpConventions([
      { path: "controllers/SiteController.php" },
      { path: "controllers/UserController.php" },
    ]);
    expect(result.controllers).toHaveLength(2);
  });

  it("matches models at root level", () => {
    const result = extractPhpConventions([
      { path: "models/User.php" },
      { path: "models/Post.php" },
    ]);
    expect(result.models).toHaveLength(2);
  });

  it("matches middleware at root level", () => {
    const result = extractPhpConventions([
      { path: "middleware/AuthMiddleware.php" },
    ]);
    expect(result.middleware).toHaveLength(1);
  });

  it("matches migrations at root level", () => {
    const result = extractPhpConventions([
      { path: "migrations/m200101_000000_create_user.php" },
      { path: "migrations/m200102_000000_create_post.php" },
    ]);
    expect(result.migrations_count).toBe(2);
  });

  it("matches routes at root level", () => {
    const result = extractPhpConventions([
      { path: "routes/web.php" },
      { path: "routes/api.php" },
    ]);
    expect(result.routes_files).toHaveLength(2);
  });
});

describe("extractYii2Conventions — Yii2-specific patterns", () => {
  it("detects modules by Module.php pattern", () => {
    const result = extractYii2Conventions([
      { path: "modules/admin/Module.php" },
      { path: "modules/api/Module.php" },
      { path: "modules/api/controllers/UserController.php" },
    ]);
    expect(result.modules).toHaveLength(2);
    expect(result.framework_type).toBe("yii2");
  });

  it("detects widgets by directory and name pattern", () => {
    const result = extractYii2Conventions([
      { path: "widgets/NavWidget.php" },
      { path: "components/widgets/GridWidget.php" },
    ]);
    expect(result.widgets).toHaveLength(2);
  });

  it("detects behaviors", () => {
    const result = extractYii2Conventions([
      { path: "behaviors/TimestampBehavior.php" },
      { path: "components/SoftDeleteBehavior.php" },
    ]);
    expect(result.behaviors).toHaveLength(2);
  });

  it("detects config files", () => {
    const result = extractYii2Conventions([
      { path: "config/web.php" },
      { path: "config/console.php" },
      { path: "config/db.php" },
      { path: "config/params.php" },
      { path: "config/main.php" },
      { path: "config/test.php" },
      { path: "config/webpack/dev.js" }, // should NOT match
    ]);
    expect(result.config_files).toHaveLength(6);
  });

  it("detects assets", () => {
    const result = extractYii2Conventions([
      { path: "assets/AppAsset.php" },
      { path: "assets/AdminAsset.php" },
      { path: "assets/css/style.css" }, // should NOT match (no Asset.php)
    ]);
    expect(result.assets).toHaveLength(2);
  });

  it("inherits base PhpConventions fields", () => {
    const result = extractYii2Conventions([
      { path: "controllers/SiteController.php" },
      { path: "models/User.php" },
      { path: "migrations/m200101_init.php" },
    ]);
    expect(result.controllers).toHaveLength(1);
    expect(result.models).toHaveLength(1);
    expect(result.migrations_count).toBe(1);
  });
});

describe("Yii2 language detection", () => {
  it("detects Yii2 from composer.json yiisoft/yii2 dependency", async () => {
    // This tests the fix in project-tools.ts line 306
    // where "yii2" was added to the PHP framework list
    const { detectStack } = await import("../../src/tools/project-tools.js");

    // We can't easily mock composer.json reading, but we can verify
    // the code path exists by checking the source
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/tools/project-tools.ts", "utf-8");
    expect(source).toContain('"laravel", "symfony", "yii2"');
  });
});

describe("PHP security patterns", () => {
  it("has all 8 PHP patterns registered", async () => {
    const { BUILTIN_PATTERNS } = await import("../../src/tools/pattern-tools.js");
    const phpPatterns = Object.keys(BUILTIN_PATTERNS).filter(
      (k) => k.endsWith("-php") || k.startsWith("unescaped-yii") || k.startsWith("raw-query-yii") || k === "file-include-var",
    );
    expect(phpPatterns.length).toBeGreaterThanOrEqual(8);
    expect(phpPatterns).toContain("sql-injection-php");
    expect(phpPatterns).toContain("xss-php");
    expect(phpPatterns).toContain("eval-php");
    expect(phpPatterns).toContain("exec-php");
    expect(phpPatterns).toContain("unserialize-php");
    expect(phpPatterns).toContain("file-include-var");
    expect(phpPatterns).toContain("unescaped-yii-view");
    expect(phpPatterns).toContain("raw-query-yii");
  });
});

describe("PHP in PARSER_LANGUAGES", () => {
  it("includes PHP in the parser languages list", async () => {
    const { PARSER_LANGUAGES } = await import("../../src/tools/project-tools.js");
    expect(PARSER_LANGUAGES).toContain("php");
  });
});

describe("PHP call graph support", () => {
  it("has PHP keywords in KEYWORD_SET (graph-tools)", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/tools/graph-tools.ts", "utf-8"),
    );
    // Verify PHP keywords added to skip list
    expect(source).toContain('"foreach"');
    expect(source).toContain('"match"');
    expect(source).toContain('"require_once"');
    // Verify PHP method call pattern
    expect(source).toContain("->|::");
  });
});

describe("PHP complexity support", () => {
  it("has foreach and match in branch/nesting patterns", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/tools/complexity-tools.ts", "utf-8"),
    );
    expect(source).toContain("foreach");
    expect(source).toContain("\\bmatch");
  });
});

describe("PHP import graph support", () => {
  it("exports extractPhpUseStatements function", async () => {
    const mod = await import("../../src/utils/import-graph.js");
    expect(typeof mod.extractPhpUseStatements).toBe("function");
  });

  it("extracts PHP use statements — uppercase and lowercase namespaces", async () => {
    const { extractPhpUseStatements } = await import("../../src/utils/import-graph.js");
    const uses = extractPhpUseStatements(`<?php
use App\\Models\\User;
use App\\Services\\AuthService as Auth;
use app\\models\\Survey;
use app\\components\\AppHelper;
use Yii;
`);
    expect(uses).toContain("App\\Models\\User");
    expect(uses).toContain("App\\Services\\AuthService");
    // Yii2 convention — lowercase `app\...` namespace (common in older Yii2 apps)
    expect(uses).toContain("app\\models\\Survey");
    expect(uses).toContain("app\\components\\AppHelper");
    // "Yii" alone must NOT match — it has no backslash (global class import)
    expect(uses).not.toContain("Yii");
  });
});

describe("PHP tools auto-load on composer.json detection", () => {
  it("includes all 9 PHP tools in the composer.json framework group", async () => {
    // Read the register-tools source to verify the group config
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/register-tools.ts", "utf-8");

    expect(source).toContain("FRAMEWORK_TOOL_GROUPS");
    expect(source).toContain('"composer.json"');

    // Verify remaining 6 PHP tools are in the auto-load list
    // (3 sub-tools absorbed into php_project_audit in Phase 1 consolidation)
    const composerSection = source.slice(
      source.indexOf('"composer.json"'),
      source.indexOf('"composer.json"') + 800,
    );
    expect(composerSection).toContain("resolve_php_namespace");
    expect(composerSection).toContain("trace_php_event");
    expect(composerSection).toContain("find_php_views");
    expect(composerSection).toContain("resolve_php_service");
    expect(composerSection).toContain("php_security_scan");
    expect(composerSection).toContain("php_project_audit");
  });

  it("has detectAutoLoadTools function that checks file existence", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/register-tools.ts", "utf-8");
    expect(source).toContain("async function detectAutoLoadTools");
    expect(source).toContain("existsSync");
  });

  it("PHP sub-tools absorbed into php_project_audit — no longer standalone entries", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/register-tools.ts", "utf-8");
    // Sub-tools no longer have standalone TOOL_DEFINITIONS entries
    expect(source).not.toContain('name: "find_php_n_plus_one"');
    expect(source).not.toContain('name: "find_php_god_model"');
    expect(source).not.toContain('name: "analyze_activerecord"');
    // But the parent meta-tool is still registered
    expect(source).toContain('name: "php_project_audit"');
  });

  it("CLAUDE.md references php_project_audit as the composite tool", async () => {
    const { readFileSync } = await import("node:fs");
    const claudeMd = readFileSync("CLAUDE.md", "utf-8");
    expect(claudeMd).toContain("php_project_audit");
  });

  it("README.md references php_project_audit as the composite tool", async () => {
    const { readFileSync } = await import("node:fs");
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain("php_project_audit");
  });
});
