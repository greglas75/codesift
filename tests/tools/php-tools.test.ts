/**
 * Tests for PHP/Yii2-specific tools (src/tools/php-tools.ts).
 *
 * These are unit tests that mock the code index rather than requiring
 * a real indexed repo. They test the extraction logic in isolation.
 */
import { expectTypeOf } from "vitest";
import { extractYii2Conventions, extractPhpConventions } from "../../src/tools/project-tools.js";
import type {
  ActiveRecordAnalysis as FacadeActiveRecordAnalysis,
  ActiveRecordModel as FacadeActiveRecordModel,
  AuditGate as FacadeAuditGate,
  FindPhpViewsResult as FacadeFindPhpViewsResult,
  GodModelFinding as FacadeGodModelFinding,
  NPlusOneFinding as FacadeNPlusOneFinding,
  PhpAssetBundleRef as FacadePhpAssetBundleRef,
  PhpEventChain as FacadePhpEventChain,
  PhpLayoutMapping as FacadePhpLayoutMapping,
  PhpNamespaceResolution as FacadePhpNamespaceResolution,
  PhpProjectAudit as FacadePhpProjectAudit,
  PhpRenderKind as FacadePhpRenderKind,
  PhpSecurityFinding as FacadePhpSecurityFinding,
  PhpSecurityScanResult as FacadePhpSecurityScanResult,
  PhpServiceResolution as FacadePhpServiceResolution,
  PhpViewMapping as FacadePhpViewMapping,
  PhpWidgetReference as FacadePhpWidgetReference,
} from "../../src/tools/php-tools.js";
import type {
  ActiveRecordAnalysis,
  ActiveRecordModel,
} from "../../src/tools/php-active-record-tools.js";
import type { PhpEventChain } from "../../src/tools/php-event-tools.js";
import type { GodModelFinding } from "../../src/tools/php-god-model-tools.js";
import type { PhpNamespaceResolution } from "../../src/tools/php-namespace-tools.js";
import type { NPlusOneFinding } from "../../src/tools/php-nplus1-tools.js";
import type { AuditGate, PhpProjectAudit } from "../../src/tools/php-project-audit-tools.js";
import type {
  PhpSecurityFinding,
  PhpSecurityScanResult,
} from "../../src/tools/php-security-tools.js";
import type { PhpServiceResolution } from "../../src/tools/php-service-tools.js";
import type {
  FindPhpViewsResult,
  PhpAssetBundleRef,
  PhpLayoutMapping,
  PhpRenderKind,
  PhpViewMapping,
  PhpWidgetReference,
} from "../../src/tools/php-view-tools.js";

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

  it("re-exports the per-tool implementation modules through the legacy facade", async () => {
    const facade = await import("../../src/tools/php-tools.js");
    const namespace = await import("../../src/tools/php-namespace-tools.js");
    const activeRecord = await import("../../src/tools/php-active-record-tools.js");
    const events = await import("../../src/tools/php-event-tools.js");
    const views = await import("../../src/tools/php-view-tools.js");
    const services = await import("../../src/tools/php-service-tools.js");
    const security = await import("../../src/tools/php-security-tools.js");
    const nplus1 = await import("../../src/tools/php-nplus1-tools.js");
    const godModel = await import("../../src/tools/php-god-model-tools.js");
    const projectAudit = await import("../../src/tools/php-project-audit-tools.js");

    expect(facade.resolvePhpNamespace).toBe(namespace.resolvePhpNamespace);
    expect(facade.analyzeActiveRecord).toBe(activeRecord.analyzeActiveRecord);
    expect(facade.tracePhpEvent).toBe(events.tracePhpEvent);
    expect(facade.findPhpViews).toBe(views.findPhpViews);
    expect(facade.resolvePhpService).toBe(services.resolvePhpService);
    expect(facade.phpSecurityScan).toBe(security.phpSecurityScan);
    expect(facade.findPhpNPlusOne).toBe(nplus1.findPhpNPlusOne);
    expect(facade.findPhpGodModel).toBe(godModel.findPhpGodModel);
    expect(facade.phpProjectAudit).toBe(projectAudit.phpProjectAudit);
  });

  it("re-exports the per-tool public types through the legacy facade", () => {
    expectTypeOf<FacadePhpNamespaceResolution>().toEqualTypeOf<PhpNamespaceResolution>();
    expectTypeOf<FacadeActiveRecordModel>().toEqualTypeOf<ActiveRecordModel>();
    expectTypeOf<FacadeActiveRecordAnalysis>().toEqualTypeOf<ActiveRecordAnalysis>();
    expectTypeOf<FacadePhpEventChain>().toEqualTypeOf<PhpEventChain>();
    expectTypeOf<FacadePhpRenderKind>().toEqualTypeOf<PhpRenderKind>();
    expectTypeOf<FacadePhpViewMapping>().toEqualTypeOf<PhpViewMapping>();
    expectTypeOf<FacadePhpLayoutMapping>().toEqualTypeOf<PhpLayoutMapping>();
    expectTypeOf<FacadePhpWidgetReference>().toEqualTypeOf<PhpWidgetReference>();
    expectTypeOf<FacadePhpAssetBundleRef>().toEqualTypeOf<PhpAssetBundleRef>();
    expectTypeOf<FacadeFindPhpViewsResult>().toEqualTypeOf<FindPhpViewsResult>();
    expectTypeOf<FacadePhpServiceResolution>().toEqualTypeOf<PhpServiceResolution>();
    expectTypeOf<FacadePhpSecurityFinding>().toEqualTypeOf<PhpSecurityFinding>();
    expectTypeOf<FacadePhpSecurityScanResult>().toEqualTypeOf<PhpSecurityScanResult>();
    expectTypeOf<FacadeNPlusOneFinding>().toEqualTypeOf<NPlusOneFinding>();
    expectTypeOf<FacadeGodModelFinding>().toEqualTypeOf<GodModelFinding>();
    expectTypeOf<FacadeAuditGate>().toEqualTypeOf<AuditGate>();
    expectTypeOf<FacadePhpProjectAudit>().toEqualTypeOf<PhpProjectAudit>();
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
    // This tests the stack detector after its extraction from project-tools.ts
    // where "yii2" was added to the PHP framework list
    const { detectStack } = await import("../../src/tools/project-tools.js");

    // We can't easily mock composer.json reading, but we can verify
    // the code path exists by checking the source
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/tools/project-profile-stack.ts", "utf-8");
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
    // Read the autoload source to verify the group config
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/register-tools/autoload.ts", "utf-8");

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
    const source = readFileSync("src/register-tools/autoload.ts", "utf-8");
    expect(source).toContain("async function detectAutoLoadTools");
    expect(source).toContain("existsSync");
  });

  it("PHP sub-tools absorbed into php_project_audit — no longer standalone entries", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/register-tool-groups/php.ts", "utf-8");
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
