/**
 * Yii2 RBAC audit (N3).
 *
 * Builds a permission graph by cross-referencing two surfaces:
 *
 *   1. DEFINITIONS — permissions/roles created in seed migrations or
 *      RBAC seeder commands. The Yii2 idiom is:
 *
 *        $auth = Yii::$app->authManager;
 *        $auth->createPermission('viewUser');     // permission def
 *        $auth->createRole('admin');              // role def
 *        $auth->add($p);                          // register
 *        $auth->addChild($admin, $p);             // attach to role
 *
 *   2. RUNTIME CHECKS — `Yii::$app->user->can('viewUser')` calls in
 *      controllers/views, plus `AccessControl` rules in behaviors().
 *
 * Cross-referencing the two surfaces produces:
 *
 *   - orphan_checks:   permissions checked at runtime but never defined.
 *                      Indicates dead code OR a typo.
 *   - unused_definitions: permissions defined but never checked. Indicates
 *                         dead seed code OR a missing access guard.
 *   - controllers_without_access_control: classes that look like Controllers
 *                                         (web, REST) without any access
 *                                         restriction (no AccessControl in
 *                                         behaviors(), no can() calls).
 *   - dynamic_creates: createPermission($var) calls — name is computed at
 *                      runtime, can't statically resolve. Surfaced
 *                      separately so callers can flag them as "review
 *                      manually".
 *
 * The tool deliberately avoids opinions about which finding category is
 * "correct" — the consumer (audit skill, CTO, code reviewer) decides
 * which orphans matter and which were intentional.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RbacDefinitionRef {
  name: string;
  kind: "permission" | "role";
  file: string;
  line: number;
}

export interface RbacCheckRef {
  name: string;
  /** "code" — Yii::$app->user->can(...)
   *  "access-control" — AccessControl behavior `permissions => […]` */
  source: "code" | "access-control";
  file: string;
  line: number;
}

export interface RbacControllerRef {
  class: string;
  file: string;
  /** Reason it was flagged. */
  reason: "no-behaviors" | "no-access-control-in-behaviors" | "no-can-calls";
}

export interface YiiRbacAudit {
  repo: string;
  /** Resolved (statically determinable) permission/role definitions. */
  definitions: RbacDefinitionRef[];
  /** Runtime can() calls + AccessControl rule references. */
  checks: RbacCheckRef[];
  /** Permissions checked at runtime but not in definitions. */
  orphan_checks: string[];
  /** Permissions defined but never checked. */
  unused_definitions: string[];
  /** Controller classes with no AccessControl behavior or can() calls. */
  controllers_without_access_control: RbacControllerRef[];
  /** Sites where the permission name was a variable / function call —
   *  unresolvable statically. Flagged so the auditor reviews manually. */
  dynamic_creates: Array<{ file: string; line: number; snippet: string }>;
  /** Aggregate counts. */
  summary: {
    total_permissions: number;
    total_roles: number;
    total_checks: number;
    orphan_check_count: number;
    unused_definition_count: number;
    unsafe_controller_count: number;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime|tests\/_data)(\/|$)/;

export async function analyzeYiiRbac(
  repo: string,
  options?: { include_vendor?: boolean },
): Promise<YiiRbacAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const includeVendor = options?.include_vendor ?? false;
  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (!includeVendor && VENDOR_RE.test(f.path)) return false;
    return true;
  });

  const definitions: RbacDefinitionRef[] = [];
  const checks: RbacCheckRef[] = [];
  const dynamicCreates: YiiRbacAudit["dynamic_creates"] = [];

  // Single-pass file read — every file scanned for all three surfaces.
  await Promise.all(
    phpFiles.map(async (f) => {
      let content: string;
      try {
        content = await readFile(join(index.root, f.path), "utf-8");
      } catch {
        return;
      }
      collectDefinitions(content, f.path, definitions, dynamicCreates);
      collectChecks(content, f.path, checks);
    }),
  );

  // Build name sets for orphan/unused diff. Definitions and checks are kept
  // separately by kind — only "permission" definitions are matched against
  // can() checks, since checking a role name with can() is a semantic error
  // (Yii2's UserComponent::can resolves both, but the audit categorizes
  // them distinctly).
  const definedPermissionNames = new Set(
    definitions.filter((d) => d.kind === "permission").map((d) => d.name),
  );
  const definedRoleNames = new Set(
    definitions.filter((d) => d.kind === "role").map((d) => d.name),
  );
  const allDefinedNames = new Set([
    ...definedPermissionNames,
    ...definedRoleNames,
  ]);

  const checkedNames = new Set(checks.map((c) => c.name));

  const orphanChecks = [...checkedNames]
    .filter((n) => !allDefinedNames.has(n))
    .sort();

  // Unused definitions: only permissions matter — unused roles often exist
  // intentionally (e.g., a `superadmin` role with no can() check, but
  // assigned via authManager->assign()). We surface only permissions to
  // keep noise down; consumers can look at the full definitions[] list
  // when they want role-level analysis.
  const unusedDefinitions = [...definedPermissionNames]
    .filter((n) => !checkedNames.has(n))
    .sort();

  // Controllers without access control. We need to read each Controller
  // class symbol's source for behaviors() body presence + can() calls.
  const controllers = scanControllersWithoutAccessControl(index);

  return {
    repo,
    definitions,
    checks,
    orphan_checks: orphanChecks,
    unused_definitions: unusedDefinitions,
    controllers_without_access_control: controllers,
    dynamic_creates: dynamicCreates,
    summary: {
      total_permissions: definedPermissionNames.size,
      total_roles: definedRoleNames.size,
      total_checks: checkedNames.size,
      orphan_check_count: orphanChecks.length,
      unused_definition_count: unusedDefinitions.length,
      unsafe_controller_count: controllers.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Surface 1: definitions
// ---------------------------------------------------------------------------

function collectDefinitions(
  content: string,
  file: string,
  definitions: RbacDefinitionRef[],
  dynamicCreates: YiiRbacAudit["dynamic_creates"],
): void {
  // Pattern A: ->createPermission('name') / ->createRole('name')
  // Match $auth->createPermission(...) and $authManager->createPermission(...)
  // as well as Yii::$app->authManager->createPermission(...)
  const createRe =
    /->(createPermission|createRole)\s*\(\s*(['"]([^'"]+)['"]|\$\w+|[A-Z_][\w]*::[\w]+)/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(content)) !== null) {
    const verb = m[1]!;
    const literal = m[3];
    const line = countLines(content, m.index);

    if (literal !== undefined) {
      definitions.push({
        name: literal,
        kind: verb === "createPermission" ? "permission" : "role",
        file,
        line,
      });
    } else {
      dynamicCreates.push({
        file,
        line,
        snippet: extractLine(content, m.index),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Surface 2: runtime checks
// ---------------------------------------------------------------------------

function collectChecks(
  content: string,
  file: string,
  checks: RbacCheckRef[],
): void {
  // Pattern A: Yii::$app->user->can('name') OR \Yii::$app->user->can('name')
  // OR shortcut Yii::$app->can('name') (rare but legal in custom UserComponents)
  const canRe = /(?:Yii|\\Yii)::\$app->user->can\s*\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = canRe.exec(content)) !== null) {
    checks.push({
      name: m[1]!,
      source: "code",
      file,
      line: countLines(content, m.index),
    });
  }

  // Pattern B: AccessControl rule with 'permissions' => ['name1', 'name2']
  // We capture the entire array body and then split out individual names.
  // Bounded 1000-char window after the keyword to avoid runaway matches on
  // huge controllers. The rule can contain arbitrary other keys; we just
  // need the permissions list.
  const acRe = /['"]permissions['"]\s*=>\s*\[([^\]]{0,2000})\]/g;
  while ((m = acRe.exec(content)) !== null) {
    const inner = m[1]!;
    const perRe = /['"]([\w-]+)['"]/g;
    let pm: RegExpExecArray | null;
    while ((pm = perRe.exec(inner)) !== null) {
      checks.push({
        name: pm[1]!,
        source: "access-control",
        file,
        line: countLines(content, m.index + pm.index),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Surface 3: controllers without access control
// ---------------------------------------------------------------------------

interface IndexLike {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    parent?: string | undefined;
    source?: string | undefined;
    extends?: string[] | undefined;
  }>;
}

function scanControllersWithoutAccessControl(
  index: IndexLike,
): RbacControllerRef[] {
  const out: RbacControllerRef[] = [];

  // Find class symbols whose name ends in Controller AND that aren't in
  // vendor/. We don't try to walk the inheritance tree to identify "real"
  // Yii2 Controllers — a class named *Controller in the user's own code is
  // 99% a real Yii2 controller, and the false-positive cost is one extra
  // line in the report.
  const controllers = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.name.endsWith("Controller")) return false;
    if (!s.file.endsWith(".php")) return false;
    if (VENDOR_RE.test(s.file)) return false;
    if (!s.source) return false;
    return true;
  });

  for (const ctrl of controllers) {
    const src = ctrl.source!;

    const hasBehaviors = /\bfunction\s+behaviors\s*\(/.test(src);
    const hasAccessControl = /AccessControl::class|['"]access['"]\s*=>\s*\[\s*['"]class['"]\s*=>\s*[^\]]*AccessControl/.test(src);
    const hasCan = /->can\s*\(/.test(src);

    if (!hasBehaviors) {
      out.push({ class: ctrl.name, file: ctrl.file, reason: "no-behaviors" });
      continue;
    }
    if (!hasAccessControl && !hasCan) {
      out.push({
        class: ctrl.name,
        file: ctrl.file,
        reason: "no-access-control-in-behaviors",
      });
      continue;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractLine(source: string, idx: number): string {
  const start = source.lastIndexOf("\n", idx) + 1;
  const end = source.indexOf("\n", idx);
  const line = source.slice(start, end === -1 ? source.length : end);
  return line.trim().slice(0, 200);
}
