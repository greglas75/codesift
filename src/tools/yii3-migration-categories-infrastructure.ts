/** Routing and infrastructure Yii2-to-Yii3 migration rules. */

import type { CategoryDefinition } from "./yii3-migration-types.js";

export const INFRASTRUCTURE_CATEGORIES: CategoryDefinition[] = [
  {
    category: "url-manager",
    severity: "high",
    description:
      "Yii::$app->urlManager / urlManager rules in config — Yii3 uses a Router package + attribute-based routes.",
    yii3_replacement:
      "Migrate `urlManager` rules to `yiisoft/router` + per-action `#[Route]` attributes.",
    effort_per_call: "medium",
    patterns: [
      /\\?\bYii::\$app->urlManager->/g,
      /[\'\"]urlManager[\'\"]\s*=>\s*\[/g,
    ],
  },
  {
    category: "console",
    severity: "high",
    description:
      "Console controllers extending yii\\console\\Controller — Yii3 console uses Symfony Console.",
    yii3_replacement:
      "Rewrite each console controller as a `Symfony\\Component\\Console\\Command\\Command` subclass.",
    effort_per_call: "medium",
    patterns: [
      /\bextends\s+(?:\\?yii\\console\\Controller|Controller)\b/g,
    ],
  },
  {
    category: "migrations",
    severity: "low",
    description:
      "Migrations extending yii\\db\\Migration — Yii3 has `yiisoft/db-migration` with similar API.",
    yii3_replacement:
      "Largely API-compatible. Migrate base class import; bulk-replace `extends Migration` with the new namespace.",
    effort_per_call: "trivial",
    patterns: [
      /\bextends\s+(?:\\?yii\\db\\Migration|Migration)\b/g,
    ],
  },
  {
    category: "queue",
    severity: "medium",
    description:
      "Yii::$app->queue / yii\\queue\\Queue — Yii3 has `yiisoft/queue` (or use Symfony Messenger).",
    yii3_replacement:
      "Rewrite jobs to implement Yii3 queue's MessageInterface or Symfony Messenger handlers.",
    effort_per_call: "small",
    patterns: [
      /\\?\bYii::\$app->queue\b/g,
      /\bextends\s+(?:\\?yii\\queue\\)/g,
      /\bimplements\s+(?:\\?yii\\queue\\JobInterface|JobInterface)\b/g,
    ],
  },
  {
    category: "rbac",
    severity: "high",
    description:
      "Yii::$app->authManager (createPermission/createRole/add/addChild) and ->can() — Yii3 uses yiisoft/rbac.",
    yii3_replacement:
      "Migrate seed migrations to `yiisoft/rbac` Manager API. ->can() becomes `Manager::userHasPermission()`.",
    effort_per_call: "medium",
    // Yii2 RBAC seed migrations universally alias the manager into a local
    // variable (`$auth = Yii::$app->authManager;`) and then call
    // `$auth->createRole/createPermission/add/addChild` — so we can't rely
    // on a single combined regex. We catch:
    //   1. The aliased read itself (any reference to `Yii::$app->authManager`)
    //   2. RBAC builder method names (createRole/createPermission/add/addChild/
    //      assign/revoke/getRole/getPermission/checkAccess)
    //   3. The runtime check `Yii::$app->user->can(...)`.
    patterns: [
      /\\?\bYii::\$app->authManager\b/g,
      /->(?:createRole|createPermission|addChild|assign|revoke|getRole|getPermission|checkAccess)\s*\(/g,
      /\\?\bYii::\$app->user->can\s*\(/g,
    ],
  },
];
