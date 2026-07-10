/** Runtime and global API Yii2-to-Yii3 migration rules. */

import type { CategoryDefinition } from "./yii3-migration-types.js";

export const RUNTIME_CATEGORIES: CategoryDefinition[] = [
  {
    category: "service-locator",
    severity: "critical",
    description:
      "Yii::$app->X service locator access — every call site needs DI ctor injection in Yii3.",
    yii3_replacement:
      "Inject the service via constructor (e.g. `public function __construct(private Connection $db)`).",
    effort_per_call: "small",
    patterns: [
      // Catches both Yii::$app->X and \Yii::$app->X. Excludes the more
      // specific subcategories below by NOT matching their well-known
      // property names — those land in their own buckets.
      /\\?\bYii::\$app->(?!request\b|response\b|session\b|user\b|urlManager\b|authManager\b|queue\b|view\b|controller\b|errorHandler\b|id\b|params\b|language\b|name\b|homeUrl\b|formatter\b|i18n\b)([a-zA-Z_][\w]*)/g,
    ],
  },
  {
    category: "object-factory",
    severity: "high",
    description:
      "Yii::createObject() factory — Yii3 uses a PSR-11 container directly.",
    yii3_replacement:
      "Resolve via Yii3 DI: `$container->get(ClassName::class)`. Most call sites can become constructor injection.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::createObject\s*\(/g],
  },
  {
    category: "aliases",
    severity: "high",
    description:
      "Yii::getAlias / Yii::setAlias path-alias system — Yii3 has a dedicated Aliases service.",
    yii3_replacement:
      "Inject `Yiisoft\\Aliases\\Aliases` and use its API.",
    effort_per_call: "small",
    patterns: [/\\?\bYii::(?:getAlias|setAlias)\s*\(/g],
  },
  {
    category: "i18n",
    severity: "high",
    description:
      "Yii::t() translation calls — Yii3 uses a TranslatorInterface injected per consumer.",
    yii3_replacement:
      "Inject `Yiisoft\\Translator\\TranslatorInterface`. Message files migrate to PO/PHP arrays per package.",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::t\s*\(/g],
  },
  {
    category: "logger",
    severity: "high",
    description:
      "Yii::error / Yii::info / Yii::warning / Yii::trace — Yii3 uses PSR-3 LoggerInterface.",
    yii3_replacement:
      "Inject `Psr\\Log\\LoggerInterface` and call `$logger->info(...)`, `$logger->error(...)`.",
    effort_per_call: "trivial",
    patterns: [/\\?\bYii::(?:error|info|warning|trace|debug|beginProfile|endProfile)\s*\(/g],
  },
];
