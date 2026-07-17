/** Application service Yii2-to-Yii3 migration rules. */

import type { CategoryDefinition } from "./yii3-migration-types.js";

export const APPLICATION_CATEGORIES: CategoryDefinition[] = [
  {
    category: "application-props",
    severity: "medium",
    description:
      "Yii::$app->id / params / language / homeUrl / name — Yii3 splits these across several services.",
    yii3_replacement:
      "Read via dedicated service (Application name / Aliases / Translator locale / Params service).",
    effort_per_call: "trivial",
    patterns: [
      /\\?\bYii::\$app->(?:id|params|language|homeUrl|name|formatter|i18n)\b/g,
    ],
  },
  {
    category: "module",
    severity: "critical",
    description:
      "Class extends yii\\base\\Module — Yii3 has no module concept; flatten to packages or use DI scopes.",
    yii3_replacement:
      "Convert each module into a Composer package or restructure into namespaces with their own DI bindings.",
    effort_per_call: "large",
    patterns: [
      /\bextends\s+(?:\\?yii\\base\\Module|Module)\b/g,
    ],
  },
  {
    category: "request",
    severity: "high",
    description:
      "Yii::$app->request->X — replace with PSR-7 ServerRequestInterface.",
    yii3_replacement:
      "Inject `Psr\\Http\\Message\\ServerRequestInterface` (or a Yii Request decorator).",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->request->/g],
  },
  {
    category: "response",
    severity: "high",
    description:
      "Yii::$app->response->X — replace with PSR-7 ResponseFactoryInterface.",
    yii3_replacement:
      "Inject `Psr\\Http\\Message\\ResponseFactoryInterface` and return `ResponseInterface`.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->response->/g],
  },
  {
    category: "session",
    severity: "medium",
    description:
      "Yii::$app->session->X — Yii3 has a session package with its own interface.",
    yii3_replacement:
      "Inject `Yiisoft\\Session\\SessionInterface` (or PSR-15 session middleware).",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::\$app->session->/g],
  },
  {
    category: "user-identity",
    severity: "high",
    description:
      "Yii::$app->user->identity / id / isGuest / can — auth shape differs in Yii3.",
    yii3_replacement:
      "Inject `Yiisoft\\Auth\\IdentityInterface` (or a project-specific identity service) + RBAC package.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::\$app->user->/g],
  },
];
