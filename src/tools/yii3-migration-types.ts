/** Public data contracts for the Yii3 migration audit. */

export type Yii3MigrationCategoryName =
  | "service-locator"
  | "object-factory"
  | "aliases"
  | "i18n"
  | "logger"
  | "application-props"
  | "module"
  | "request"
  | "response"
  | "session"
  | "user-identity"
  | "active-record"
  | "validators"
  | "form-model"
  | "widgets"
  | "view"
  | "url-manager"
  | "console"
  | "migrations"
  | "queue"
  | "rbac";

export type Severity = "critical" | "high" | "medium" | "low";
export type EffortBucket = "trivial" | "small" | "medium" | "large";

export interface CategoryDefinition {
  category: Yii3MigrationCategoryName;
  severity: Severity;
  description: string;
  yii3_replacement: string;
  effort_per_call: EffortBucket;
  /** One or more regexes; a file is counted once per match. The regex must
   *  be globally flagged so we can iterate matches in a single source pass. */
  patterns: RegExp[];
}

export interface CategoryFinding {
  category: Yii3MigrationCategoryName;
  severity: Severity;
  count: number;
  effort_per_call: EffortBucket;
  description: string;
  yii3_replacement: string;
  /** First few file:line:snippet triples — capped to keep output tight. */
  sample_files: Array<{
    file: string;
    line: number;
    snippet: string;
  }>;
}

export interface Yii3MigrationAudit {
  repo: string;
  scanned_files: number;
  total_call_sites: number;
  by_category: CategoryFinding[];
  by_severity: Record<Severity, number>;
  blockers: Array<{
    category: Yii3MigrationCategoryName;
    reason: string;
    related_files_count: number;
  }>;
  effort_estimate: {
    hours_low: number;
    hours_high: number;
    note: string;
  };
  decision_signal:
    | "stay-on-yii2"
    | "consider-yii3"
    | "high-effort-yii3"
    | "blocked";
  yii_version_detected: string | null;
  php_version_required: string | null;
}
