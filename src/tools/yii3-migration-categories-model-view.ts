/** Model and presentation Yii2-to-Yii3 migration rules. */

import type { CategoryDefinition } from "./yii3-migration-types.js";

export const MODEL_VIEW_CATEGORIES: CategoryDefinition[] = [
  {
    category: "active-record",
    severity: "critical",
    description:
      "ActiveRecord (yii\\db\\ActiveRecord) — Yii3 has no AR core. Pick Cycle ORM or yiisoft/active-record.",
    yii3_replacement:
      "Cycle ORM (preferred for new code) or `yiisoft/active-record` (closer to Yii2 API).",
    effort_per_call: "medium",
    patterns: [
      /\bextends\s+(?:\\?yii\\db\\ActiveRecord|ActiveRecord)\b/g,
    ],
  },
  {
    category: "validators",
    severity: "high",
    description:
      "Yii2 rules() validation array — Yii3 uses `yiisoft/validator` with attributes or rule objects.",
    yii3_replacement:
      "Replace `rules()` with attribute-based validation (`#[Required, Email]`) or a Validator service.",
    effort_per_call: "small",
    // Heuristic: a `rules()` method that returns an array. We count one per
    // class that defines such a method. False positives possible if a class
    // unrelated to Yii2 has its own rules().
    patterns: [
      /\bpublic\s+function\s+rules\s*\(\s*\)\s*(?::\s*array\s*)?\{/g,
    ],
  },
  {
    category: "form-model",
    severity: "high",
    description:
      "Form models extending yii\\base\\Model with load() + validate() — Yii3 has `yiisoft/form-model`.",
    yii3_replacement:
      "Migrate to `yiisoft/form-model`. The `load()`/`validate()` lifecycle moves to FormModelInterface.",
    effort_per_call: "small",
    patterns: [
      /\bextends\s+(?:\\?yii\\base\\Model|Model)\b(?!\\)/g,
      /->load\s*\(\s*Yii::\$app->request->post\s*\(\s*\)\s*\)/g,
    ],
  },
  {
    category: "widgets",
    severity: "high",
    description:
      "Yii2 widgets (GridView, ActiveForm, Pjax, ListView) — Yii3 splits widgets into separate packages and some are gone.",
    yii3_replacement:
      "Per widget: use `yiisoft/yii-bootstrap5`, `yiisoft/yii-gridview`, `yiisoft/form` or rewrite as Twig/Vue components.",
    effort_per_call: "medium",
    patterns: [
      /\b(?:GridView|ActiveForm|Pjax|ListView|DetailView|Breadcrumbs|Menu|LinkPager)::(?:widget|begin)\s*\(/g,
    ],
  },
  {
    category: "view",
    severity: "high",
    description:
      "$this->render() / $this->layout — Yii3 has a yii-view package with a different lifecycle.",
    yii3_replacement:
      "Inject `Yiisoft\\View\\ViewInterface`. `$this->layout` becomes view parameters/decorators.",
    effort_per_call: "small",
    patterns: [
      /\$this->render(?:Partial|Ajax|AsJson|File)?\s*\(/g,
      /\$this->layout\s*=/g,
    ],
  },
];
