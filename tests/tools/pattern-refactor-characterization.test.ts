import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import {
  BUILTIN_PATTERNS,
  listPatterns,
  searchPatterns,
} from "../../src/tools/pattern-tools.js";
import { BUILTIN_PATTERNS as REGISTRY_PATTERNS } from "../../src/tools/pattern-registry.js";
import { resetConfigCache } from "../../src/config.js";

let tmpDir: string | undefined;

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

const COMMON_PATTERN_NAMES = new Set([
  "empty-catch",
  "any-type",
  "console-log",
  "await-in-loop",
  "no-error-type",
  "toctou",
  "unbounded-findmany",
  "scaffolding",
]);

const ADAPTER_FAMILIES: Array<[string, (name: string) => boolean, number]> = [
  ["common", (name) => COMMON_PATTERN_NAMES.has(name), 8],
  ["kotlin", (name) => /^(runblocking|globalscope|data-class|lateinit|empty-when|mutable-shared|kotest|compose)-/.test(name), 11],
  ["php", (name) => /^(sql-injection-php|xss-php|eval-php|exec-php|unserialize-php|file-include-var|unescaped-yii-view|raw-query-yii|yii-|php-)/.test(name), 25],
  ["nest", (name) => name.startsWith("nest-"), 24],
  ["astro", (name) => name.startsWith("astro-"), 13],
  ["next", (name) => name.startsWith("nextjs-"), 10],
  ["hono", (name) => name.startsWith("hono-"), 7],
  ["database", (name) => /^(unsafe-|transaction-|migration-)/.test(name), 6],
  ["python", (name) => /^(mutable-default|bare-except|broad-except|global-keyword|star-import|print-debug-py|eval-exec|shell-true|pickle-load|yaml-unsafe|open-no-with|string-concat-loop|datetime-naive|shadow-builtin|n-plus-one-django|late-binding|assert-tuple)$/.test(name), 17],
  ["react", (name) => !COMMON_PATTERN_NAMES.has(name) && !/^(runblocking|globalscope|data-class|lateinit|empty-when|mutable-shared|kotest|compose|sql-injection-php|xss-php|eval-php|exec-php|unserialize-php|file-include-var|unescaped-yii-view|raw-query-yii|yii-|php-|nest-|astro-|nextjs-|hono-|unsafe-|transaction-|migration-|mutable-default|bare-except|broad-except|global-keyword|star-import|print-debug-py|eval-exec|shell-true|pickle-load|yaml-unsafe|open-no-with|string-concat-loop|datetime-naive|shadow-builtin|n-plus-one-django|late-binding|assert-tuple)/.test(name), 47],
];

const EXPECTED_PATTERN_ORDER = [
  "useEffect-no-cleanup",
  "hook-in-condition",
  "useEffect-async",
  "useEffect-object-dep",
  "missing-display-name",
  "index-as-key",
  "inline-handler",
  "conditional-render-hook",
  "dangerously-set-html",
  "direct-dom-access",
  "unstable-default-value",
  "jsx-falsy-and",
  "nested-component-def",
  "usecallback-no-deps",
  "react19-use-without-suspense",
  "react19-server-action-not-async",
  "react19-form-action-non-function",
  "react19-useoptimistic-no-transition",
  "hook-usestate-destructure",
  "prefer-function-component",
  "compiler-side-effect-in-render",
  "compiler-ref-read-in-render",
  "compiler-prop-mutation",
  "compiler-state-mutation",
  "compiler-try-catch-bailout",
  "compiler-redundant-memo",
  "compiler-redundant-usecallback",
  "rsc-non-serializable-prop",
  "rsc-date-prop",
  "useEffect-missing-cleanup",
  "useEffect-setstate-loop",
  "useEffect-missing-deps-identifier",
  "nextjs-use-cache-without-tag",
  "nextjs-revalidatetag-deprecated",
  "tanstack-missing-invalidation",
  "derived-state",
  "stale-closure-setstate",
  "context-provider-value-inline",
  "jsx-no-target-blank",
  "button-no-type",
  "derived-state-reducer",
  "derived-state-custom-setter",
  "stale-closure-toggle",
  "stale-closure-broken-functional",
  "context-provider-value-via-variable",
  "context-provider-value-inline-destructured",
  "react-lazy-no-suspense-same-file",
  "error-boundary-incomplete",
  "rsc-non-serializable-prop-deep",
  "empty-catch",
  "any-type",
  "console-log",
  "await-in-loop",
  "no-error-type",
  "toctou",
  "unbounded-findmany",
  "scaffolding",
  "runblocking-in-coroutine",
  "globalscope-launch",
  "data-class-mutable",
  "lateinit-no-check",
  "empty-when-branch",
  "mutable-shared-state",
  "kotest-missing-assertion",
  "kotest-mixed-styles",
  "compose-missing-remember",
  "compose-unstable-lambda",
  "compose-side-effect-in-composition",
  "sql-injection-php",
  "xss-php",
  "eval-php",
  "exec-php",
  "unserialize-php",
  "file-include-var",
  "unescaped-yii-view",
  "raw-query-yii",
  "yii-csrf-disabled",
  "yii-debug-mode-prod",
  "yii-cookie-no-validation",
  "yii-mass-assignment-unsafe",
  "yii-raw-sql-where",
  "php-md5-password",
  "php-rand-token",
  "php-loose-comparison-secret",
  "yii-rbac-cached-permission",
  "yii-no-row-level-locking",
  "yii-config-hardcoded-secret",
  "yii-unbounded-all",
  "yii-translate-in-loop",
  "yii-dbtarget-info-level",
  "yii-find-with-large-then-filter",
  "yii-cache-no-ttl",
  "yii-no-batch-on-large",
  "nest-circular-inject",
  "nest-catch-all-filter",
  "nest-request-scope",
  "nest-raw-exception",
  "nest-any-guard-return",
  "nest-service-locator",
  "nest-direct-env",
  "nest-graphql-no-auth",
  "nest-eager-relation",
  "nest-typeorm-synchronize-prod",
  "nest-exposed-stack-trace",
  "nest-raw-entity-response",
  "nest-cors-wildcard",
  "nest-disabled-csrf",
  "nest-missing-guard-method",
  "nest-missing-pipe-transform",
  "nest-missing-filter-catch",
  "nest-missing-interceptor-intercept",
  "nest-param-decorator-no-type",
  "nest-orm-in-controller",
  "nest-business-logic-in-controller",
  "nest-moduleref-get",
  "nest-sync-fs-in-handler",
  "nest-require-primary-key",
  "astro-client-on-astro",
  "astro-glob-usage",
  "astro-set-html-xss",
  "astro-img-element",
  "astro-missing-getStaticPaths",
  "astro-legacy-content-collections",
  "astro-no-image-dimensions",
  "astro-inline-script-no-is-inline",
  "astro-env-secret-in-client",
  "astro-hardcoded-site-url",
  "astro-missing-lang-attr",
  "astro-form-without-action",
  "astro-view-transitions-deprecated",
  "nextjs-wrong-router",
  "nextjs-fetch-waterfall",
  "nextjs-unnecessary-use-client",
  "nextjs-pages-in-app",
  "nextjs-missing-error-boundary",
  "nextjs-use-client-in-layout",
  "nextjs-missing-metadata",
  "nextjs-missing-use-client",
  "hono-missing-error-handler",
  "hono-throw-raw-error",
  "hono-missing-validator",
  "hono-unguarded-json-parse",
  "hono-env-type-any",
  "hono-missing-status-code",
  "hono-full-app-rpc-export",
  "unsafe-raw-sql",
  "transaction-external-io",
  "migration-create-index-no-concurrently",
  "migration-drop-column",
  "migration-alter-column-type",
  "migration-not-null-no-default",
  "mutable-default",
  "bare-except",
  "broad-except",
  "global-keyword",
  "star-import",
  "print-debug-py",
  "eval-exec",
  "shell-true",
  "pickle-load",
  "yaml-unsafe",
  "open-no-with",
  "string-concat-loop",
  "datetime-naive",
  "shadow-builtin",
  "n-plus-one-django",
  "late-binding",
  "assert-tuple",
] as const;

async function createIndexedFixture(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-pattern-refactor-"));
  const project = join(tmpDir, "project");
  const sourcePath = join(project, "src", "sample.ts");
  await mkdir(join(sourcePath, ".."), { recursive: true });
  await writeFile(sourcePath, "export function sample() { console.log(\"fixture\"); }\n");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  await indexFolder(project, { watch: false });
  return "local/project";
}

describe("pattern split characterization", () => {
  it("preserves the registry facade identity, order, and complete catalog", () => {
    expect(BUILTIN_PATTERNS).toBe(REGISTRY_PATTERNS);
    const names = Object.keys(REGISTRY_PATTERNS);
    expect(names).toEqual([...EXPECTED_PATTERN_ORDER]);
    expect(listPatterns().map((pattern) => pattern.name)).toEqual([...EXPECTED_PATTERN_ORDER]);

    for (const [family, matches, expectedCount] of ADAPTER_FAMILIES) {
      expect(names.filter(matches), `${family} adapter catalog`).toHaveLength(expectedCount);
    }
  });

  it("preserves the generic execution path for a built-in pattern", async () => {
    const repo = await createIndexedFixture();
    const result = await searchPatterns(repo, "console-log");

    expect(result.pattern).toContain("console-log");
    expect(result.scanned_symbols).toBeGreaterThan(0);
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: "src/sample.ts",
        matched_pattern: expect.stringContaining("console-log"),
        context: expect.stringContaining("console.log"),
      }),
    ]));
  });
});
